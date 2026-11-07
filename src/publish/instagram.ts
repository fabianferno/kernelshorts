import { join } from "node:path";
import { PATHS, env } from "./settings.js";
import { readJsonIfExists, writeSecretJson } from "./store.js";

/**
 * Instagram API with Instagram Login (graph.instagram.com), Reels only.
 *
 * Setup (once): the account is a Creator (or Business) account; a Meta app with
 * the "Instagram" product; the account added to the app with a role (Standard
 * Access is enough for your own account, no App Review); generate a token in
 * the app dashboard with instagram_business_basic +
 * instagram_business_content_publish → INSTAGRAM_ACCESS_TOKEN in .env, then
 * `pnpm post auth instagram`.
 *
 * Long-lived tokens last 60 days and can be refreshed once they are 24 h old;
 * the scheduler refreshes any token older than 7 days, so it never lapses as
 * long as the Mac runs a check now and then.
 *
 * Publishing: create a REELS container from a public video_url, poll until
 * FINISHED, then media_publish. There is no native scheduling — the
 * scheduler calls this at the slot. Limit: 50 posts per rolling 24 h.
 */

const GRAPH = "https://graph.instagram.com/v27.0";
const AUTH_FILE = join(PATHS.auth, "instagram.json");

interface IgAuth {
  access_token: string;
  user_id: string;
  username: string;
  account_type?: string;
  refreshed_at: string;
  expires_at?: string;
}

async function graph<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params);
  const r =
    method === "GET"
      ? await fetch(`${GRAPH}${path}?${qs}`)
      : await fetch(`${GRAPH}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: qs,
        });
  const j = (await r.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string };
  };
  if (!r.ok || j.error) {
    const e = j.error;
    const hint = e?.code === 190 ? " — token expired or revoked; generate a new one and run `pnpm post auth instagram`" : "";
    throw new Error(
      `Instagram ${method} ${path}: ${r.status} ${e?.message ?? ""}${e?.error_user_msg ? ` (${e.error_user_msg})` : ""}${hint}`,
    );
  }
  return j;
}

export async function instagramAccount(): Promise<IgAuth | undefined> {
  return readJsonIfExists<IgAuth>(AUTH_FILE);
}

/** Validate the token from .env and remember which account it belongs to. */
export async function authorizeInstagram(): Promise<IgAuth> {
  const token = env.instagramAccessToken;
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN missing from .env (see docs/publishing.md)");
  const me = await graph<{ user_id: string; username: string; account_type?: string }>("GET", "/me", {
    fields: "user_id,username,account_type",
    access_token: token,
  });
  if (me.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(me.account_type)) {
    throw new Error(`@${me.username} is a ${me.account_type} account — switch it to Creator in the Instagram app first`);
  }
  const auth: IgAuth = {
    access_token: token,
    user_id: me.user_id,
    username: me.username,
    account_type: me.account_type,
    refreshed_at: new Date().toISOString(),
  };
  await writeSecretJson(AUTH_FILE, auth);
  return auth;
}

async function auth(): Promise<IgAuth> {
  const a = await readJsonIfExists<IgAuth>(AUTH_FILE);
  if (!a) throw new Error("Instagram is not connected — run `pnpm post auth instagram`");
  const age = Date.now() - new Date(a.refreshed_at).getTime();
  if (age > 7 * 86_400_000) {
    const r = await graph<{ access_token: string; expires_in: number }>("GET", "/refresh_access_token", {
      grant_type: "ig_refresh_token",
      access_token: a.access_token,
    });
    a.access_token = r.access_token;
    a.refreshed_at = new Date().toISOString();
    a.expires_at = new Date(Date.now() + r.expires_in * 1000).toISOString();
    await writeSecretJson(AUTH_FILE, a);
  }
  return a;
}

/** Keep the token alive even in weeks with nothing to post. */
export async function keepInstagramTokenFresh(): Promise<void> {
  if (await readJsonIfExists<IgAuth>(AUTH_FILE)) await auth();
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

export async function containerStatus(id: string): Promise<{ status_code: ContainerStatus; status?: string }> {
  const a = await auth();
  return graph("GET", `/${id}`, { fields: "status_code,status", access_token: a.access_token });
}

export async function createReelContainer(videoUrl: string, caption: string): Promise<string> {
  const a = await auth();
  const r = await graph<{ id: string }>("POST", `/${a.user_id}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
    access_token: a.access_token,
  });
  return r.id;
}

/** Poll (every 15 s, up to 10 min) until Instagram has fetched and processed the video. */
export async function waitForContainer(id: string): Promise<void> {
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    const s = await containerStatus(id);
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new Error(`Instagram couldn't process the video: ${s.status_code} ${s.status ?? ""}`);
    }
    if (s.status_code === "PUBLISHED") return;
    if (Date.now() > until) throw new Error(`Instagram still processing after 10 min (${s.status_code})`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

export async function publishContainer(id: string): Promise<{ mediaId: string; permalink?: string }> {
  const a = await auth();
  const r = await graph<{ id: string }>("POST", `/${a.user_id}/media_publish`, {
    creation_id: id,
    access_token: a.access_token,
  });
  return { mediaId: r.id, permalink: await permalink(r.id) };
}

export async function permalink(mediaId: string): Promise<string | undefined> {
  const a = await auth();
  const m = await graph<{ permalink?: string }>("GET", `/${mediaId}`, {
    fields: "permalink",
    access_token: a.access_token,
  });
  return m.permalink;
}

/**
 * A run that died between media_publish and saving the result leaves a
 * container in PUBLISHED with no media id on record. Find the post it became
 * (newest posts whose caption matches) instead of publishing a second copy.
 */
export async function findPublishedByCaption(caption: string): Promise<{ mediaId: string; permalink?: string } | undefined> {
  const a = await auth();
  const r = await graph<{ data: { id: string; caption?: string; permalink?: string }[] }>("GET", `/${a.user_id}/media`, {
    fields: "id,caption,permalink",
    limit: "10",
    access_token: a.access_token,
  });
  const hit = r.data.find((m) => (m.caption ?? "").trim() === caption.trim());
  return hit && { mediaId: hit.id, permalink: hit.permalink };
}

export async function publishingQuota(): Promise<{ used: number; total: number }> {
  const a = await auth();
  const r = await graph<{ data: { quota_usage: number; config?: { quota_total: number } }[] }>(
    "GET", `/${a.user_id}/content_publishing_limit`, { fields: "quota_usage,config", access_token: a.access_token },
  );
  return { used: r.data[0]?.quota_usage ?? 0, total: r.data[0]?.config?.quota_total ?? 50 };
}
