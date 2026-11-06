/**
 * Source material for a reel, as one readable Markdown file — from ANY input.
 *
 *   pnpm run source <anything>     → ~/pipeline/sources/<slug>.md (+ media next to it)
 *   pnpm run source --front        → today's HN front page
 *   (`pnpm run`, not `pnpm source`: pnpm has a built-in by that name)
 *
 * Routing:
 *   local file path        notes / doc / PDF / recording / image   (src/source/local.ts)
 *   x.com / twitter.com    post text, author, quote, stats; its video transcribed if any
 *   reddit.com/…/comments  post + top comments
 *   github.com/<o>/<r>     README + repo stats
 *   HN item / id           linked article + top of the discussion
 *   reel / short / tiktok / youtube   downloaded, transcribed, frame sheets  (src/source/video.ts)
 *   any other URL          readable article text; JS-built pages re-fetched in a real browser
 *   plain text "topic"     a topic brief — Claude researches it
 *
 * Nothing here calls an LLM: the /reel skill has Claude Code read the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchPage, extractReadable } from "../src/source/fetch-source.js";
import { parseHnId, fetchItem, fetchFrontPage, flattenComments } from "../src/source/hn.js";
import { slugify } from "../src/run/execute.js";
import { isVideoUrl, fetchVideoSource } from "../src/source/video.js";
import { parseTweetUrl, fetchTweet, isRedditUrl, fetchReddit, parseGitHubRepo, fetchGitHubReadme } from "../src/source/social.js";
import { asLocalPath, readLocalSource } from "../src/source/local.js";

const SOURCES = join(process.env.HOME ?? "~", "pipeline", "sources");
const REMAKE_RULE = (credit: string) =>
  [
    "> Remake rule: use the FACTS and the ANGLE, write every line fresh in our",
    "> formula and voice, verify numbers against a primary source, and credit",
    `> the source (source_note "via ${credit}"). Never reuse its wording or visuals.`,
    "",
  ].join("\n");

const arg = process.argv.slice(2).join(" ").trim();
if (!arg) {
  console.error('usage: pnpm run source <url | file path | HN id | "a topic"> | --front');
  process.exit(2);
}

async function save(title: string, body: string, suffix = ""): Promise<void> {
  await mkdir(SOURCES, { recursive: true });
  const path = join(SOURCES, `${slugify(title || "source", 48)}${suffix ? `-${suffix}` : ""}.md`);
  await writeFile(path, body);
  console.log(`${path}\n${body.length.toLocaleString()} chars · ${title}`);
}

const isUrl = /^https?:\/\//i.test(arg);
const log = (m: string) => console.log(`  ${m}`);

// ── HN front page ───────────────────────────────────────────────────────────
if (arg === "--front") {
  for (const s of await fetchFrontPage()) {
    console.log(`${String(s.points).padStart(5)}  ${s.id}  ${s.title}${s.url ? `  (${new URL(s.url).hostname})` : ""}`);
  }
  process.exit(0);
}

// ── local file ──────────────────────────────────────────────────────────────
const local = !isUrl ? asLocalPath(arg) : undefined;
if (local) {
  const { title, markdown } = await readLocalSource(local);
  await save(title, markdown, "file");
  process.exit(0);
}

// ── X / Twitter ─────────────────────────────────────────────────────────────
const tweet = isUrl ? parseTweetUrl(arg) : undefined;
if (tweet) {
  const t = await fetchTweet(tweet.id);
  let body = `${t.markdown}\n\n${REMAKE_RULE(t.handle)}`;
  if (t.hasVideo) {
    log("post has a video — downloading + transcribing it");
    const v = await fetchVideoSource(arg, join(SOURCES, `x-${tweet.id}`), log);
    body += ["", "## Video transcript (Soniox STT)", "", ...v.transcript, "", `Frames: ${v.hookSheet} · ${v.sheet}`].join("\n");
  }
  await save(t.title, body, tweet.id);
  process.exit(0);
}

// ── Reddit ──────────────────────────────────────────────────────────────────
if (isUrl && isRedditUrl(arg)) {
  try {
    const r = await fetchReddit(arg);
    await save(r.title, `${r.markdown}\n\n${REMAKE_RULE(r.handle)}`, "reddit");
    process.exit(0);
  } catch (err) {
    // Reddit refuses unauthenticated JSON (403, 2026-11-06); read the page itself below.
    log(`reddit API unavailable (${(err as Error).message}) — reading the page instead`);
  }
}

// ── GitHub repo ─────────────────────────────────────────────────────────────
const gh = isUrl ? parseGitHubRepo(arg) : undefined;
if (gh) {
  const g = await fetchGitHubReadme(gh.owner, gh.repo);
  await save(g.title, g.markdown, "github");
  process.exit(0);
}

// ── reel / short / tiktok / youtube ─────────────────────────────────────────
if (isUrl && isVideoUrl(arg)) {
  const id = slugify(new URL(arg).pathname.replace(/\/+$/, "").split("/").pop() || "video", 40);
  const v = await fetchVideoSource(arg, join(SOURCES, `video-${id}`), log);
  const md = [
    `# ${v.title}`,
    `Video source: ${v.url}`,
    `Creator: ${v.creator} (${v.handle}) · ${v.durationS ? `${Math.round(v.durationS)}s` : "length unknown"}`,
    "",
    REMAKE_RULE(v.handle),
    "## Description",
    "",
    v.description || "(none)",
    "",
    "## Transcript (Soniox STT)",
    "",
    ...v.transcript,
    "",
    "## Frames",
    "",
    `- hook, first 8 s at 0.5 s: ${v.hookSheet}`,
    `- whole video: ${v.sheet}`,
    `- video file: ${v.videoPath}`,
  ].join("\n");
  await save(v.title || id, md, id);
  process.exit(0);
}

// ── plain-text topic (not a URL, not a file, not an HN id) ──────────────────
const hnId = parseHnId(arg);
if (!isUrl && !hnId) {
  await save(arg, [`# ${arg}`, "Topic brief (no source document).", "", "Research it: find primary sources for every number before scripting."].join("\n"), "topic");
  process.exit(0);
}

// ── HN item and/or any web page ─────────────────────────────────────────────
const parts: string[] = [];
let title = "";
let articleUrl: string | undefined = hnId ? undefined : arg;

if (hnId) {
  const item = await fetchItem(hnId);
  title = item.title;
  articleUrl = item.url;
  parts.push(`# ${item.title}`, `HN: https://news.ycombinator.com/item?id=${hnId} · ${item.points} points · ${item.created_at}`);
  if (articleUrl) parts.push(`Article: ${articleUrl}`);
}

/** Readable text of a page; JS-built pages (thin static HTML) re-fetched in Chromium. */
async function readArticle(url: string): Promise<{ title: string; text: string; via: string }> {
  const page = await fetchPage(url);
  const readable = extractReadable(page.html, page.url);
  if (readable.text.length >= 800) return { title: readable.title, text: readable.text, via: "fetch" };
  log(`only ${readable.text.length} chars without JavaScript — rendering in a browser`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
    const rendered = extractReadable(await p.content(), p.url());
    return rendered.text.length > readable.text.length
      ? { title: rendered.title || readable.title, text: rendered.text, via: "browser" }
      : { title: readable.title, text: readable.text, via: "fetch" };
  } finally {
    await browser.close();
  }
}

/** Bot walls are not content. Never save one as a source, and never try to get past one. */
const BLOCKED = /prove your humanity|are you a robot|captcha|access denied|just a moment|verify you are human|enable javascript and cookies/i;

if (articleUrl) {
  try {
    const a = await readArticle(articleUrl);
    if (BLOCKED.test(a.title) || (a.text.length < 1500 && BLOCKED.test(a.text))) {
      console.error(
        `${articleUrl} is behind a bot check ("${a.title}"), so it can't be read automatically.\n` +
          `Copy the post's text into a file and run: pnpm run source <that file>  (or paste it to Claude).`,
      );
      process.exit(1);
    }
    title ||= a.title;
    if (!hnId) parts.push(`# ${a.title}`, `Source: ${articleUrl}`, "", REMAKE_RULE(new URL(articleUrl).hostname));
    parts.push("", `## Article (${a.via})`, "", a.text);
  } catch (err) {
    parts.push("", "## Article", "", `(could not fetch ${articleUrl}: ${(err as Error).message})`);
  }
}

if (hnId) {
  const comments = flattenComments((await fetchItem(hnId)) as never);
  parts.push("", `## Top of the HN discussion (${comments.length})`, "");
  for (const c of comments) parts.push(`${"  ".repeat(c.depth - 1)}- **${c.author}**: ${c.text.replace(/\n+/g, " ")}`);
}

await save(title || articleUrl || String(hnId), parts.join("\n"));
