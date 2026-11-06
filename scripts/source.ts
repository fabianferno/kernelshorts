/**
 * Source material for a reel, as one readable Markdown file.
 *
 *   pnpm exec tsx scripts/source.ts <url | HN item url | HN id>   → writes ~/pipeline/sources/<slug>.md
 *   pnpm exec tsx scripts/source.ts <reel / short / tiktok url>    → downloads, transcribes, frame sheets
 *   pnpm exec tsx scripts/source.ts --front                       → lists today's HN front page
 *
 * For an HN item it pulls the linked article AND the top of the discussion
 * (the best counter-arguments and numbers are often in the comments). Nothing
 * here calls an LLM: the /reel skill has Claude Code read the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchPage, extractReadable } from "../src/source/fetch-source.js";
import { parseHnId, fetchItem, fetchFrontPage, flattenComments } from "../src/source/hn.js";
import { slugify } from "../src/run/execute.js";
import { isVideoUrl, fetchVideoSource } from "../src/source/video.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/source.ts <article url | HN url | HN id | reel/short url> | --front");
  process.exit(2);
}

if (arg === "--front") {
  for (const s of await fetchFrontPage()) {
    console.log(`${String(s.points).padStart(5)}  ${s.id}  ${s.title}${s.url ? `  (${new URL(s.url).hostname})` : ""}`);
  }
  process.exit(0);
}

if (isVideoUrl(arg)) {
  const base = join(process.env.HOME ?? "~", "pipeline", "sources");
  const id = slugify(new URL(arg).pathname.replace(/\/+$/, "").split("/").pop() || "video", 40);
  const dir = join(base, `video-${id}`);
  const v = await fetchVideoSource(arg, dir, (m) => console.log(`  ${m}`));
  const md = [
    `# ${v.title}`,
    `Video source: ${v.url}`,
    `Creator: ${v.creator} (${v.handle}) · ${v.durationS ? `${Math.round(v.durationS)}s` : "length unknown"}`,
    "",
    "> Remake rule: use the FACTS and the ANGLE, write every line fresh in our",
    "> formula and voice, verify numbers against a primary source, and credit",
    `> the creator (source_note "via ${v.handle}"). Never reuse their wording or visuals.`,
    "",
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
  const path = join(base, `${slugify(v.title || "video", 40)}-${id}.md`);
  await mkdir(base, { recursive: true });
  await writeFile(path, md);
  console.log(`${path}\n${v.transcript.length} transcript lines · ${Math.round(v.durationS)}s · ${v.handle}`);
  process.exit(0);
}

const hnId = parseHnId(arg);
const parts: string[] = [];
let title = "";
let articleUrl: string | undefined = hnId ? undefined : arg;

if (hnId) {
  const item = await fetchItem(hnId);
  title = item.title;
  articleUrl = item.url;
  parts.push(
    `# ${item.title}`,
    `HN: https://news.ycombinator.com/item?id=${hnId} · ${item.points} points · ${item.created_at}`,
  );
  if (articleUrl) parts.push(`Article: ${articleUrl}`);
}

if (articleUrl) {
  try {
    const page = await fetchPage(articleUrl);
    const readable = extractReadable(page.html, page.url);
    title ||= readable.title;
    if (!hnId) parts.push(`# ${readable.title}`, `Source: ${page.url}`);
    parts.push("", "## Article", "", readable.text);
  } catch (err) {
    parts.push("", `## Article`, "", `(could not fetch ${articleUrl}: ${(err as Error).message})`);
  }
}

if (hnId) {
  const comments = flattenComments((await fetchItem(hnId)) as never);
  parts.push("", `## Top of the HN discussion (${comments.length})`, "");
  for (const c of comments) {
    parts.push(`${"  ".repeat(c.depth - 1)}- **${c.author}**: ${c.text.replace(/\n+/g, " ")}`);
  }
}

const dir = join(process.env.HOME ?? "~", "pipeline", "sources");
await mkdir(dir, { recursive: true });
const path = join(dir, `${slugify(title || articleUrl || String(hnId))}.md`);
const body = parts.join("\n");
await writeFile(path, body);
console.log(`${path}\n${body.length.toLocaleString()} chars · ${title}`);
