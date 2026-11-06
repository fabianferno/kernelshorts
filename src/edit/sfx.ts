import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const exec = promisify(execFile);

/**
 * One generic "bloop" for every visual entrance (user, 2026-11-07: "something
 * generic — like bloop — so you don't have to decide what sound for what").
 *
 * Synthesised with ffmpeg, not downloaded: no licence to track, identical on
 * every machine, and no asset to lose. A sine whose pitch glides UP fast
 * (exponential approach to the top note) under a 4 ms attack and a ~55 ms
 * decay — a soft, rounded pop that sits under speech instead of on top of it.
 * Three pitches, cycled beat by beat, so twelve entrances don't sound like
 * the same click twelve times.
 */
export const BLOOP = {
  durationS: 0.24,
  /** [start Hz, end Hz] of each variant's glide. */
  variants: [
    [300, 720],
    [340, 820],
    [270, 640],
  ] as const,
  /** Mix level (linear). Measured 2026-11-07: RMS peak −24 dB vs the VO's
   *  −10 dB — ~14 dB under the voice: heard, never over a word. */
  gain: 0.45,
  /** Land with the prop's fade-in rather than on the cut itself. */
  offsetS: 0.05,
} as const;

const SFX_DIR = join(homedir(), "pipeline", "sfx");

function expr(f0: number, f1: number): string {
  // phase(t) = 2π ∫ f(t) dt  for  f(t) = f1 − (f1 − f0)·e^(−t/τ)
  const tau = 0.022;
  const phase = `2*PI*(${f1}*t-${f1 - f0}*${tau}*(1-exp(-t/${tau})))`;
  const env = `(1-exp(-t/0.004))*exp(-t/0.055)`;
  // a touch of 2nd harmonic for body
  return `0.6*${env}*(sin(${phase})+0.18*sin(2*${phase}))`;
}

/** Paths of the bloop variants, synthesising any that are missing (cached). */
export async function ensureBloops(dir = SFX_DIR): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const [i, [f0, f1]] of BLOOP.variants.entries()) {
    const path = join(dir, `bloop-${i}.wav`);
    if (!existsSync(path)) {
      await exec("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `aevalsrc=${expr(f0, f1)}:s=48000:d=${BLOOP.durationS}`,
        "-ac", "2", "-c:a", "pcm_s16le", path,
      ]);
    }
    out.push(path);
  }
  return out;
}
