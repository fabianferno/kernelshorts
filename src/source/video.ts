import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { transcribeFile } from "../verify/timeline.js";
import { wordsFromTokens } from "../tts/voice.js";

const exec = promisify(execFile);

/**
 * A short video (Instagram reel, YouTube Short, TikTok…) as SOURCE material:
 * downloaded with yt-dlp, transcribed with Soniox STT, and sampled into frame
 * sheets so Claude can see how it's built. The /reel skill then writes an
 * ORIGINAL script in our style from it — facts and angle, not wording — and
 * credits the creator.
 */
const VIDEO_HOSTS = /(^|\.)(instagram\.com|youtube\.com|youtu\.be|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|threads\.net)$/i;

export function isVideoUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (!VIDEO_HOSTS.test(u.hostname)) return false;
    // youtube.com non-video pages (channels) aren't sources
    if (/youtube\.com$/i.test(u.hostname)) return /\/(shorts|watch|live)\b/.test(u.pathname) || u.searchParams.has("v");
    return true;
  } catch {
    return false;
  }
}

export interface VideoSource {
  url: string;
  title: string;
  /** Display name. */
  creator: string;
  /** @handle for credit lines (Instagram puts it in `channel`). */
  handle: string;
  description: string;
  durationS: number;
  videoPath: string;
  /** "[m:ss] sentence" lines, in order. */
  transcript: string[];
  hookSheet: string;
  sheet: string;
}

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export async function fetchVideoSource(url: string, outDir: string, log: (m: string) => void = () => {}): Promise<VideoSource> {
  await mkdir(outDir, { recursive: true });
  log(`downloading ${url}`);
  await exec(
    "yt-dlp",
    ["--no-playlist", "--write-info-json", "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4",
      "-o", join(outDir, "video.%(ext)s"), url],
    { maxBuffer: 1 << 24, timeout: 300_000 },
  );
  const files = await readdir(outDir);
  const video = files.find((f) => /^video\.(mp4|webm|mkv|mov)$/.test(f));
  const infoFile = files.find((f) => f.endsWith(".info.json"));
  if (!video) throw new Error(`yt-dlp produced no video in ${outDir}`);
  const info = infoFile
    ? (JSON.parse(await readFile(join(outDir, infoFile), "utf8")) as Record<string, unknown>)
    : {};
  const videoPath = join(outDir, video);
  const { probeMedia } = await import("../assets/ffprobe.js");
  const durationS = Number(info.duration ?? 0) || ((await probeMedia(videoPath)).durationS ?? 0);

  log("transcribing (Soniox STT)…");
  const transcript = await transcribeFile(videoPath);
  const words = wordsFromTokens(transcript.tokens);
  const lines: string[] = [];
  let cur: string[] = [];
  let start = 0;
  for (const w of words) {
    if (cur.length === 0) start = w.startS;
    cur.push(w.word);
    // Sentence end — but not an abbreviation like "U.S." or "Dr."
    const sentenceEnd = /[.?!]$/.test(w.word) && !/^([A-Z]\.)+$/.test(w.word) && !/^(Dr|Mr|Mrs|Ms|St|vs)\.$/.test(w.word);
    if (sentenceEnd || cur.length >= 22) {
      lines.push(`[${mmss(start)}] ${cur.join(" ")}`);
      cur = [];
    }
  }
  if (cur.length) lines.push(`[${mmss(start)}] ${cur.join(" ")}`);

  log("frame sheets…");
  const hookSheet = join(outDir, "hook.jpg");
  const sheet = join(outDir, "sheet.jpg");
  await exec("ffmpeg", ["-v", "error", "-y", "-t", "8", "-i", videoPath, "-vf", "fps=2,scale=216:-1,tile=8x2", "-frames:v", "1", hookSheet]);
  const every = Math.max(2, Math.round((durationS || 60) / 32));
  await exec("ffmpeg", ["-v", "error", "-y", "-i", videoPath, "-vf", `fps=1/${every},scale=216:-1,tile=8x4`, "-frames:v", "1", sheet]);

  const description = String(info.description ?? "").trim();
  const rawTitle = String(info.title ?? info.fulltitle ?? "").trim();
  // Instagram titles everything "Video by <user>"; the real topic is the caption's first line.
  const title = !rawTitle || /^video by /i.test(rawTitle) ? description.split("\n")[0]!.slice(0, 120) || rawTitle : rawTitle;
  const idLike = (x: unknown) => typeof x === "string" && x.length > 0 && !/^\d+$/.test(x);
  const handle = [info.channel, info.uploader_id, info.uploader].find(idLike) as string | undefined;
  return {
    url,
    title: title || "(untitled video)",
    creator: String(info.uploader ?? handle ?? "unknown creator"),
    handle: handle ? `@${handle.replace(/^@/, "")}` : String(info.uploader ?? "unknown creator"),
    description,
    durationS,
    videoPath,
    transcript: lines,
    hookSheet,
    sheet,
  };
}
