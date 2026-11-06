/**
 * Contact sheets for Claude Code to review a render with its own eyes
 * (the "self" reviewer of the /reel skill).
 *
 *   pnpm exec tsx scripts/review-sheet.ts <video.mp4> [--every 3]
 *
 * Writes next to the video:
 *   <name>.hook.jpg   first 10 s at 0.5 s steps (the hook decides retention)
 *   <name>.sheet.jpg  whole video at one frame every N s (default 3)
 * and prints both paths plus ffprobe facts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const video = process.argv[2];
if (!video) {
  console.error("usage: tsx scripts/review-sheet.ts <video.mp4> [--every N]");
  process.exit(2);
}
const everyIdx = process.argv.indexOf("--every");
const every = everyIdx > 0 ? Number(process.argv[everyIdx + 1]) : 3;
const base = video.replace(/\.mp4$/i, "");

const { stdout } = await exec("ffprobe", [
  "-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate",
  "-of", "json", video,
]);
const probe = JSON.parse(stdout) as {
  format: { duration: string };
  streams: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
};
const duration = Number(probe.format.duration);
const v = probe.streams.find((s) => s.width);

const hookCount = 20;
await exec("ffmpeg", [
  "-v", "error", "-y", "-t", "10", "-i", video,
  "-vf", `fps=2,scale=216:-1,tile=10x2`, "-frames:v", "1", `${base}.hook.jpg`,
]);
const n = Math.ceil(duration / every);
const cols = 8;
await exec("ffmpeg", [
  "-v", "error", "-y", "-i", video,
  "-vf", `fps=1/${every},scale=216:-1,tile=${cols}x${Math.ceil(n / cols)}`,
  "-frames:v", "1", `${base}.sheet.jpg`,
]);

console.log(
  `${video}\n  ${v?.width}x${v?.height} @ ${v?.r_frame_rate} · ${duration.toFixed(1)}s\n` +
    `  hook  (${hookCount} frames, 0.5 s apart): ${base}.hook.jpg\n` +
    `  sheet (${n} frames, ${every} s apart):    ${base}.sheet.jpg`,
);
