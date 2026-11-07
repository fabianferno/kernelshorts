import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { PATHS, postingSettings, type PostingSettings } from "./settings.js";
import { listPosts, savePost, loadPost, takenSlots, withLock, type PostRecord, type IgState, type YtState } from "./store.js";
import { PostCaptions, captionProblems } from "./captions.js";
import { nextSlot, decideDue, parseLocalDateTime, describeSlot, localParts } from "./slots.js";
import { preparePublishCopy, sha256 } from "./prepare.js";
import { withPublicFile } from "./tunnel.js";
import * as yt from "./youtube.js";
import * as ig from "./instagram.js";

export type Platform = "instagram" | "youtube";
const MAX_ATTEMPTS = 3;
const RETRY_MS = 15 * 60_000;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const log = (msg: string) => console.log(`[post ${new Date().toISOString()}] ${msg}`);

/**
 * Tell the user, on this Mac (Notification Center) and on their phone (web
 * push, when VAPID is set up). Best-effort: a notification failing must never
 * fail a publish.
 */
export async function tellUser(title: string, body: string, url?: string): Promise<void> {
  log(`${title}: ${body}${url ? ` ${url}` : ""}`);
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await new Promise<void>((ok) =>
    execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => ok()),
  );
  try {
    const { notify } = await import("../notify/push.js");
    await notify({ title, body, url });
    const { closeDb } = await import("../db/mongo.js");
    await closeDb();
  } catch {
    /* push not configured — Notification Center + log are enough */
  }
}

// ───────────────────────────── queue ─────────────────────────────

export interface QueueOptions {
  only?: Platform;
  /** "YYYY-MM-DDTHH:MM" in the posting time zone, instead of the next slot. */
  at?: string;
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
}

export async function queuePost(videoArg: string, captionsArg: string, opts: QueueOptions = {}): Promise<PostRecord> {
  const now = opts.now ?? new Date();
  const settings = postingSettings();
  const video = resolve(videoArg);
  if (!existsSync(video)) throw new Error(`No such video: ${video}`);

  const captions = PostCaptions.parse(JSON.parse(await readFile(resolve(captionsArg), "utf8")));
  if (opts.only === "instagram") delete captions.youtube;
  if (opts.only === "youtube") delete captions.instagram;
  const problems = captionProblems(captions);
  if (problems.length) throw new Error(`Captions need fixing:\n  ${problems.join("\n  ")}`);

  if (!opts.dryRun) {
    if (captions.instagram && !(await ig.instagramAccount())) throw new Error("Instagram is not connected — run `pnpm post auth instagram`");
    if (captions.youtube && !(await yt.youtubeAccount())) throw new Error("YouTube is not connected — run `pnpm post auth youtube`");
  }

  const posts = await listPosts(PATHS.posts);
  const hash = await sha256(video);
  const dup = posts.find(
    (p) => p.sha256 === hash && [p.instagram, p.youtube].some((s) => s && s.status !== "cancelled" && s.status !== "failed"),
  );
  if (dup && !opts.force) throw new Error(`This exact video is already queued/posted as ${dup.id} (use --force to post it again)`);

  const fixed = opts.at ? parseLocalDateTime(opts.at, settings.timezone) : undefined;
  if (fixed && fixed.getTime() < now.getTime()) throw new Error(`--at ${opts.at} is in the past`);
  const slotFor = (p: Platform) =>
    fixed ?? nextSlot(now, { time: settings[p].time, timezone: settings.timezone }, takenSlots(posts, p), settings.leadMinutes);

  const stem = basename(video).replace(/\.\w+$/, "").replace(/-\d{4}-\d{2}-\d{2}-\d{6}$/, "");
  const lp = localParts(now, settings.timezone);
  const day = `${lp.year}-${String(lp.month).padStart(2, "0")}-${String(lp.day).padStart(2, "0")}`;
  let id = `${day}-${stem}`;
  for (let n = 2; posts.some((p) => p.id === id); n++) id = `${day}-${stem}-${n}`;

  const rec: PostRecord = {
    id,
    created_at: now.toISOString(),
    video,
    publish_video: "",
    sha256: hash,
    ...(captions.instagram && {
      instagram: { status: "scheduled", slot: slotFor("instagram").toISOString(), attempts: 0, caption: captions.instagram.caption },
    }),
    ...(captions.youtube && {
      youtube: { status: "pending", slot: slotFor("youtube").toISOString(), attempts: 0, ...captions.youtube },
    }),
  };

  if (opts.dryRun) return rec;

  const copy = await preparePublishCopy(video, join(PATHS.posts, "media"));
  for (const w of copy.warnings) log(`warning: ${w}`);
  rec.publish_video = copy.path;
  await savePost(PATHS.posts, rec);

  // YouTube schedules natively, so upload now; the scheduler retries if this fails.
  if (rec.youtube) {
    await withLock(PATHS.posts, async () => {
      await stepYouTube(rec, new Date(), settings);
    });
  }
  return loadPost(PATHS.posts, rec.id);
}

// ───────────────────────────── due ─────────────────────────────

function retryLater<T extends IgState | YtState>(s: T, e: unknown, now: Date, failStatus: T["status"]): "retry" | "failed" {
  s.attempts += 1;
  s.last_error = errMsg(e);
  if (s.attempts >= MAX_ATTEMPTS) {
    s.status = failStatus;
    return "failed";
  }
  s.next_try = new Date(now.getTime() + RETRY_MS).toISOString();
  return "retry";
}

const notYet = (s: { next_try?: string }, now: Date) => !!s.next_try && new Date(s.next_try).getTime() > now.getTime();

async function stepYouTube(rec: PostRecord, now: Date, settings: PostingSettings): Promise<void> {
  const s = rec.youtube;
  if (!s || notYet(s, now)) return;
  const tz = settings.timezone;

  if (s.status === "pending") {
    try {
      const slot = new Date(s.slot);
      const r = await yt.uploadShort(rec.publish_video, s, slot);
      s.video_id = r.videoId;
      s.url = r.url;
      s.status = r.scheduled ? "scheduled" : "published";
      s.next_try = undefined;
      s.last_error = undefined;
      if (!r.scheduled) s.published_at = new Date().toISOString();
      await savePost(PATHS.posts, rec);
      log(`${rec.id}: YouTube upload done → ${r.url} (${r.scheduled ? `public at ${describeSlot(slot, tz)}` : "public now"})`);
      if (!r.scheduled) await tellUser("Live on YouTube", s.title, r.url);
    } catch (e) {
      const outcome = retryLater(s, e, now, "failed");
      await savePost(PATHS.posts, rec);
      log(`${rec.id}: YouTube upload failed (${s.attempts}/${MAX_ATTEMPTS}): ${s.last_error}`);
      if (outcome === "failed") await tellUser("YouTube upload failed", `${rec.id}: ${s.last_error}`);
    }
    return;
  }

  // Scheduled on YouTube's side: confirm it actually went public.
  if (s.status === "scheduled" && s.video_id && now.getTime() > new Date(s.slot).getTime() + 5 * 60_000) {
    try {
      const st = await yt.videoStatus(s.video_id);
      if (!st) throw new Error("video no longer exists on YouTube");
      if (st.uploadStatus === "rejected" || st.uploadStatus === "failed") {
        s.status = "failed";
        s.last_error = `YouTube ${st.uploadStatus}${st.rejectionReason ? `: ${st.rejectionReason}` : ""}`;
        await savePost(PATHS.posts, rec);
        await tellUser("YouTube rejected the Short", `${rec.id}: ${s.last_error}`, s.url);
      } else if (st.privacyStatus === "public") {
        s.status = "published";
        s.published_at = s.slot;
        await savePost(PATHS.posts, rec);
        await tellUser("Live on YouTube", s.title, s.url);
      } else if (now.getTime() > new Date(s.slot).getTime() + 2 * 3_600_000) {
        s.status = "failed";
        s.last_error = `still ${st.privacyStatus} 2 h after its slot — check YouTube Studio`;
        await savePost(PATHS.posts, rec);
        await tellUser("YouTube Short didn't go public", `${rec.id}: ${s.last_error}`, s.url);
      }
    } catch (e) {
      log(`${rec.id}: YouTube status check failed: ${errMsg(e)}`);
    }
  }
}

async function stepInstagram(rec: PostRecord, now: Date, settings: PostingSettings, all: PostRecord[]): Promise<void> {
  const s = rec.instagram;
  if (!s || notYet(s, now)) return;
  const tz = settings.timezone;
  const fail = async (e: unknown) => {
    s.container_id = undefined;
    const outcome = retryLater(s, e, now, "failed");
    if (outcome === "retry") s.status = "scheduled";
    await savePost(PATHS.posts, rec);
    log(`${rec.id}: Instagram publish failed (${s.attempts}/${MAX_ATTEMPTS}): ${s.last_error}`);
    if (outcome === "failed") await tellUser("Instagram post failed", `${rec.id}: ${s.last_error}`);
  };
  const done = async (r: { mediaId: string; permalink?: string }) => {
    s.status = "published";
    s.media_id = r.mediaId;
    s.url = r.permalink;
    s.published_at = new Date().toISOString();
    s.next_try = undefined;
    s.last_error = undefined;
    await savePost(PATHS.posts, rec);
    await tellUser("Live on Instagram", (s.caption.split("\n")[0] ?? "").slice(0, 100), r.permalink);
  };

  // A previous run died mid-publish: settle that container before anything else.
  if (s.status === "publishing" && s.container_id) {
    try {
      const st = await ig.containerStatus(s.container_id);
      if (st.status_code === "PUBLISHED") {
        const found = await ig.findPublishedByCaption(s.caption);
        if (found) return void (await done(found));
        throw new Error("container shows PUBLISHED but the post wasn't found — check Instagram before retrying");
      }
      if (st.status_code === "FINISHED") return void (await done(await ig.publishContainer(s.container_id)));
      return void (await fail(new Error(`interrupted publish left the container ${st.status_code}`)));
    } catch (e) {
      return void (await fail(e));
    }
  }
  if (s.status !== "scheduled") return;

  if (s.attempts === 0) {
    const d = decideDue(new Date(s.slot), now, settings.maxLateHours);
    if (d === "wait") return;
    if (d === "late") {
      const others = all.filter((p) => p.id !== rec.id);
      const missed = describeSlot(new Date(s.slot), tz);
      s.slot = nextSlot(now, { time: settings.instagram.time, timezone: tz }, takenSlots(others, "instagram"), settings.leadMinutes).toISOString();
      await savePost(PATHS.posts, rec);
      await tellUser("Instagram post moved", `Missed ${missed} (Mac asleep?). Now ${describeSlot(new Date(s.slot), tz)}.`);
      return;
    }
  }

  log(`${rec.id}: publishing to Instagram`);
  try {
    const q = await ig.publishingQuota();
    if (q.used >= q.total) throw new Error(`publishing limit reached (${q.used}/${q.total} in 24 h)`);
    const result = await withPublicFile(rec.publish_video, async (url) => {
      const id = await ig.createReelContainer(url, s.caption);
      s.status = "publishing";
      s.container_id = id;
      await savePost(PATHS.posts, rec);
      await ig.waitForContainer(id); // Instagram downloads the file while the link is up
      return ig.publishContainer(id);
    });
    await done(result);
  } catch (e) {
    await fail(e);
  }
}

/** One scheduler pass: everything due gets done, everything else is left alone. */
export async function runDue(now = new Date()): Promise<void> {
  const r = await withLock(PATHS.posts, async () => {
    const settings = postingSettings();
    const posts = await listPosts(PATHS.posts);
    for (const rec of posts) {
      await stepYouTube(rec, now, settings);
      await stepInstagram(rec, now, settings, posts);
    }
    try {
      await ig.keepInstagramTokenFresh();
    } catch (e) {
      log(`Instagram token refresh failed: ${errMsg(e)}`);
    }
  });
  if (r === "locked") log("another run is in progress; skipping");
}

// ───────────────────────────── cancel / list ─────────────────────────────

export async function cancelPost(id: string, only?: Platform): Promise<PostRecord> {
  const r = await withLock(PATHS.posts, async () => {
    const rec = await loadPost(PATHS.posts, id);
    if ((!only || only === "instagram") && rec.instagram) {
      const s = rec.instagram;
      if (s.status === "published") throw new Error(`${id} is already live on Instagram (${s.url}) — delete it in the app`);
      if (s.status === "publishing") throw new Error(`${id} is being published to Instagram right now`);
      s.status = "cancelled";
    }
    if ((!only || only === "youtube") && rec.youtube) {
      const s = rec.youtube;
      if (s.status === "published") throw new Error(`${id} is already live on YouTube (${s.url}) — delete it in Studio`);
      if (s.status === "scheduled" && s.video_id) await yt.deleteVideo(s.video_id);
      s.status = "cancelled";
    }
    await savePost(PATHS.posts, rec);
    return rec;
  });
  if (r === "locked") throw new Error("the scheduler is running right now — try again in a minute");
  return r;
}

export async function describePosts(): Promise<string> {
  const tz = postingSettings().timezone;
  const posts = await listPosts(PATHS.posts);
  if (!posts.length) return "Nothing queued.";
  return posts
    .map((p) => {
      const line = (name: string, s?: IgState | YtState) =>
        s
          ? `  ${name.padEnd(9)} ${s.status.padEnd(10)} ${describeSlot(new Date(s.slot), tz)}` +
            (s.url ? `  ${s.url}` : "") +
            (s.last_error && s.status !== "published" ? `\n            last error: ${s.last_error}` : "")
          : "";
      return [p.id, line("instagram", p.instagram), line("youtube", p.youtube)].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
