import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const exec = promisify(execFile);

/**
 * Turn the approved final cut into the file both platforms receive.
 *
 * Instagram's Reels spec (IG User Media reference) wants the moov atom at the
 * front, AAC at ≤128 kbps / ≤48 kHz, H.264/HEVC 4:2:0, 23–60 fps, ≤1920 px
 * wide, 3 s–15 min, ≤300 MB. Our renders put moov at the end and carry
 * ~200 kbps audio, so the copy remuxes the video untouched and re-encodes only
 * the audio. YouTube is happy with the same file.
 */

interface Probe {
  vcodec: string;
  pixFmt: string;
  width: number;
  height: number;
  fps: number;
  acodec?: string;
  durationS: number;
  bytes: number;
}

async function probe(path: string): Promise<Probe> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path,
  ]);
  const j = JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string }[];
    format: { duration: string; size: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`${path} has no video stream`);
  const a = j.streams.find((s) => s.codec_type === "audio");
  const [n = 0, d = 1] = (v.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    vcodec: v.codec_name,
    pixFmt: v.pix_fmt ?? "",
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: d ? n / d : 0,
    acodec: a?.codec_name,
    durationS: Number(j.format.duration),
    bytes: Number(j.format.size),
  };
}

/** Problems that would make either platform reject (or not treat it as a Short). */
export function specProblems(p: Probe): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!["h264", "hevc"].includes(p.vcodec)) errors.push(`video codec ${p.vcodec} (need h264/hevc)`);
  if (p.pixFmt !== "yuv420p") errors.push(`pixel format ${p.pixFmt} (need yuv420p)`);
  if (p.fps < 23 || p.fps > 60) errors.push(`${p.fps.toFixed(2)} fps (need 23–60)`);
  if (p.width > 1920) errors.push(`${p.width}px wide (max 1920)`);
  if (p.durationS < 3 || p.durationS > 900) errors.push(`${p.durationS.toFixed(1)} s long (need 3 s–15 min)`);
  if (p.bytes > 300 * 1024 * 1024) errors.push(`${(p.bytes / 1048576).toFixed(0)} MB (max 300)`);
  if (!p.acodec) warnings.push("no audio track");
  if (p.height <= p.width) warnings.push("not vertical: YouTube won't treat it as a Short");
  if (p.durationS > 180) warnings.push("over 3 min: YouTube won't treat it as a Short");
  return { errors, warnings };
}

export async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function preparePublishCopy(
  src: string,
  outDir: string,
): Promise<{ path: string; warnings: string[]; durationS: number }> {
  const before = await probe(src);
  const { errors, warnings } = specProblems(before);
  if (errors.length) throw new Error(`${basename(src)} can't be posted:\n  ${errors.join("\n  ")}`);

  await mkdir(outDir, { recursive: true });
  const out = join(outDir, basename(src).replace(/\.\w+$/, "") + ".publish.mp4");
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    out,
  ]);
  const after = await probe(out);
  if (Math.abs(after.durationS - before.durationS) > 0.2) {
    throw new Error(`publish copy is ${after.durationS}s but the cut is ${before.durationS}s`);
  }
  await stat(out);
  return { path: out, warnings, durationS: after.durationS };
}
