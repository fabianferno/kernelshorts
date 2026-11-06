import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Per-video-frame loudness of a VO clip, in dBFS (RMS), at `fps`.
 * Drives the host's mouth: a cartoon mouth that opens on loud syllables and
 * closes in pauses reads as talking; one flapping at a fixed rate (the first
 * version) reads as a machine.
 */
export async function loudnessPerFrame(path: string, fps: number): Promise<number[]> {
  const { stdout: sr } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path,
  ]);
  const samplesPerFrame = Math.round(Number(sr.trim()) / fps);
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v", "error", "-i", path,
      "-af",
      `aformat=channel_layouts=mono,asetnsamples=n=${samplesPerFrame}:p=0,` +
        `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null", "-",
    ],
    { maxBuffer: 1 << 26 },
  );
  return [...stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) =>
    m[1] === "-inf" ? -120 : Number(m[1]),
  );
}

/**
 * Binary mouth-open intervals from a loudness track, with hysteresis and
 * minimum durations so it opens per syllable instead of flickering.
 * Thresholds are relative to this clip's own speech level (90th percentile),
 * so a quieter voice still talks. Times are relative to the clip start.
 */
export function mouthFromLoudness(
  db: number[],
  fps: number,
  opts: { openBelowPeak?: number; closeBelowPeak?: number; minFrames?: number } = {},
): Array<{ startS: number; endS: number }> {
  if (db.length === 0) return [];
  const sorted = [...db].filter((d) => d > -90).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const peak = sorted[Math.floor(sorted.length * 0.9)]!;
  // Relative to this clip's speech level, but never below an absolute floor:
  // a silent or room-tone-only clip must keep the mouth shut (test caught a
  // -80 dB clip flapping because its "peak" was the silence itself).
  const openAt = Math.max(peak - (opts.openBelowPeak ?? 9), -48);
  const closeAt = Math.max(peak - (opts.closeBelowPeak ?? 16), -55);
  const minFrames = opts.minFrames ?? 2;

  const out: Array<{ startS: number; endS: number }> = [];
  let open = false;
  let since = 0;
  for (let f = 0; f < db.length; f++) {
    const held = f - since;
    if (!open && db[f]! >= openAt && held >= minFrames) {
      open = true;
      since = f;
    } else if (open && db[f]! < closeAt && held >= minFrames) {
      out.push({ startS: since / fps, endS: f / fps });
      open = false;
      since = f;
    } else if (open && held >= 7) {
      // Long vowels: blink shut for a frame so a held note still reads as speech.
      out.push({ startS: since / fps, endS: f / fps });
      open = false;
      since = f;
    }
  }
  if (open) out.push({ startS: since / fps, endS: db.length / fps });
  return out.map((iv) => ({ startS: Math.round(iv.startS * 1000) / 1000, endS: Math.round(iv.endS * 1000) / 1000 }));
}
