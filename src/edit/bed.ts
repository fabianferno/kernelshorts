import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { framesToSeconds } from "./units.js";
import type { BeatPlan } from "./plan-beats.js";

const exec = promisify(execFile);

/**
 * Makes the music bed sit UNDER the voice (the "voiceover carve" the
 * hyperframes-audio skill requires whenever music plays under speech), baked
 * into the bed file with ffmpeg so it works on any renderer:
 *
 *  1. loudness-normalise the bed low (-27 LUFS) — music is the floor, not a
 *     second voice;
 *  2. a static dip in the band speech intelligibility lives in (~1–3 kHz), so
 *     the bed stops competing for it even between ducks;
 *  3. a sidechain compressor keyed by the ACTUAL voiceover timeline: the bed
 *     ducks while she talks and swells back in pauses, with a slow release so
 *     it doesn't snap back between words.
 *
 * The voice clips are placed at their beat start times exactly as the
 * composition plays them, so the duck lines up with the speech.
 */
export async function carveBed(opts: {
  musicPath: string;
  plan: BeatPlan[];
  outPath: string;
}): Promise<string> {
  const { musicPath, plan, outPath } = opts;
  const totalS = framesToSeconds(plan.at(-1)?.endFrame ?? 0);
  if (totalS <= 0) throw new Error("carveBed: empty plan");
  await mkdir(dirname(outPath), { recursive: true });

  const inputs = ["-i", musicPath, ...plan.flatMap((p) => ["-i", p.voPath])];
  const voices = plan.map((p, i) => {
    const ms = Math.round(framesToSeconds(p.startFrame) * 1000);
    return `[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}:all=1[v${i}]`;
  });
  const graph = [
    `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${totalS},asetpts=PTS-STARTPTS,` +
      // loudnorm resamples to 192 kHz internally; bring it back to 44.1k.
      `loudnorm=I=-27:TP=-3:LRA=11,aresample=44100,equalizer=f=1800:t=q:w=1.1:g=-5,` +
      `afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, totalS - 1.8)}:d=1.8[m]`,
    ...voices,
    `${plan.map((_, i) => `[v${i}]`).join("")}amix=inputs=${plan.length}:normalize=0:duration=longest,` +
      `apad=whole_dur=${totalS}[vs]`,
    `[m][vs]sidechaincompress=threshold=0.015:ratio=3.5:attack=20:release=500:knee=4:makeup=1[out]`,
  ].join(";");
  await exec("ffmpeg", [
    "-v", "error", "-y", ...inputs,
    "-filter_complex", graph, "-map", "[out]", "-t", String(totalS), "-ar", "44100", "-c:a", "pcm_s16le", outPath,
  ], { maxBuffer: 1 << 24 });
  return outPath;
}
