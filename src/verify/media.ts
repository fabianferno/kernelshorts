import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { VerifierResult } from "../shared/schemas.js";

const exec = promisify(execFile);

/**
 * Layer-1 deterministic verifiers (PRD §5). These run first because they are
 * cheap and catch the failures a vision model would waste tokens describing.
 * Every check reports a real measurement from a real file.
 */

export interface ProbeInfo {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec?: string;
  frames: number;
}

export async function probe(path: string): Promise<ProbeInfo> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string; codec_name?: string; width?: number; height?: number;
      r_frame_rate?: string; nb_frames?: string;
    }>;
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  if (!v) throw new Error(`No video stream in ${path}`);
  const [num, den] = (v.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationS: Number(data.format?.duration ?? 0),
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: num && den ? num / den : 0,
    hasAudio: Boolean(a),
    videoCodec: v.codec_name ?? "unknown",
    audioCodec: a?.codec_name,
    frames: Number(v.nb_frames ?? 0),
  };
}

/** Container: duration in range, 1080x1920, expected fps, audio present. */
export async function checkContainer(path: string): Promise<VerifierResult> {
  const p = await probe(path);
  const { width, height, fps, targetDurationS } = config.video;
  const problems: string[] = [];
  if (p.width !== width || p.height !== height) {
    problems.push(`resolution ${p.width}x${p.height}, expected ${width}x${height}`);
  }
  if (Math.abs(p.fps - fps) > 0.5) problems.push(`fps ${p.fps.toFixed(2)}, expected ${fps}`);
  if (!p.hasAudio) problems.push("no audio stream");
  if (p.durationS < targetDurationS.min || p.durationS > targetDurationS.max) {
    problems.push(
      `duration ${p.durationS.toFixed(1)}s outside ` +
        `${targetDurationS.min}-${targetDurationS.max}s`,
    );
  }
  return VerifierResult.parse({
    name: "container",
    passed: problems.length === 0,
    detail: problems.length ? problems.join("; ") : "container OK",
    measured: {
      width: p.width, height: p.height, fps: Math.round(p.fps * 100) / 100,
      durationS: Math.round(p.durationS * 100) / 100,
      videoCodec: p.videoCodec, audioCodec: p.audioCodec ?? "none",
    },
  });
}

export interface LoudnessStats {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  threshold: number;
}

/** Real loudnorm measurement pass. */
export async function measureLoudness(path: string): Promise<LoudnessStats> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path,
     "-af", `loudnorm=I=${config.loudness.targetLufs}:TP=-1.5:LRA=11:print_format=json`,
     "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  const match = stderr.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse loudnorm output for ${path}`);
  const j = JSON.parse(match[0]) as Record<string, string>;
  return {
    integratedLufs: Number(j.input_i),
    truePeakDb: Number(j.input_tp),
    lra: Number(j.input_lra),
    threshold: Number(j.input_thresh),
  };
}

/**
 * Normalize-then-verify (M0 finding): Palmier exports at source level — the
 * M0 export measured −24.9 LUFS against a −14 target — so the publish master
 * is produced by a real two-pass loudnorm here, not by the editor. Publishing
 * must use the returned path, never Palmier's raw export.
 */
export async function normalizeLoudness(
  inputPath: string,
  outputPath: string,
): Promise<{ path: string; before: LoudnessStats; after: LoudnessStats }> {
  const before = await measureLoudness(inputPath);
  const target = config.loudness.targetLufs;

  // Second pass, fed the measured values — this is what makes loudnorm linear
  // and artifact-free rather than a dynamic-range mangler.
  const [lo, hi] = config.loudness.acceptRange;

  // loudnorm's `linear=true` can only apply a flat gain that keeps true peak
  // under TP. When a quiet mix already peaks near 0 dBFS (the M0 export was
  // −24.9 LUFS at −0.2 dBTP, needing ~+11 dB), the flat gain would clip, so
  // loudnorm silently falls back to dynamic mode and lands short of target —
  // measured −16.59 LUFS on the first real attempt.
  //
  // The fix is to make headroom explicitly: normalize, then apply the residual
  // gain through a true-peak limiter, re-measuring after each corrective pass.
  // Converges in one or two passes; failing to converge throws rather than
  // shipping an off-spec master.
  let current = inputPath;
  let after = before;
  for (let pass = 0; pass < 3; pass++) {
    const measured = pass === 0 ? before : after;
    const delta = target - measured.integratedLufs;
    const filter =
      pass === 0
        ? `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${measured.integratedLufs}:` +
          `measured_TP=${measured.truePeakDb}:measured_LRA=${measured.lra}:` +
          `measured_thresh=${measured.threshold}:linear=true:print_format=summary,` +
          `alimiter=limit=-1.5dB:level=disabled`
        : `volume=${delta.toFixed(2)}dB,alimiter=limit=-1.5dB:level=disabled`;

    const stage = pass === 0 ? outputPath : `${outputPath}.pass${pass}.mp4`;
    await exec("ffmpeg", [
      "-hide_banner", "-nostats", "-y", "-i", current,
      "-af", filter,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      stage,
    ], { maxBuffer: 1024 * 1024 * 16 });

    after = await measureLoudness(stage);
    current = stage;
    if (after.integratedLufs >= lo && after.integratedLufs <= hi) {
      if (stage !== outputPath) await exec("mv", [stage, outputPath]);
      return { path: outputPath, before, after };
    }
  }

  throw new Error(
    `Loudness normalization failed to converge: ${after.integratedLufs} LUFS is ` +
      `outside the accepted ${lo}..${hi} range (target ${target}) after 3 passes. ` +
      `The source mix likely needs per-clip gain staging before export.`,
  );
}

export async function checkLoudness(path: string): Promise<VerifierResult> {
  const stats = await measureLoudness(path);
  const [lo, hi] = config.loudness.acceptRange;
  const ok = stats.integratedLufs >= lo && stats.integratedLufs <= hi;
  return VerifierResult.parse({
    name: "loudness",
    passed: ok,
    detail: ok
      ? `${stats.integratedLufs} LUFS within ${lo}..${hi}`
      : `${stats.integratedLufs} LUFS outside ${lo}..${hi} — run normalizeLoudness`,
    measured: {
      integratedLufs: stats.integratedLufs,
      truePeakDb: stats.truePeakDb,
      lra: stats.lra,
    },
  });
}

/** No fully-black stretches — usually a missing or mistimed visual. */
export async function checkBlackFrames(path: string): Promise<VerifierResult> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path,
     "-vf", "blackdetect=d=0.3:pic_th=0.98", "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  const hits = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({
    start: Number(m[1]),
    end: Number(m[2]),
  }));
  return VerifierResult.parse({
    name: "blackdetect",
    passed: hits.length === 0,
    detail: hits.length
      ? `${hits.length} black segment(s): ` +
        hits.map((h) => `${h.start.toFixed(2)}-${h.end.toFixed(2)}s`).join(", ")
      : "no black segments",
    measured: { segments: hits.length },
  });
}

/** No frozen stretches — a stalled screen recording reads as a broken video. */
export async function checkFrozenFrames(path: string): Promise<VerifierResult> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path,
     "-vf", "freezedetect=n=-60dB:d=2", "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  const hits = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return VerifierResult.parse({
    name: "freezedetect",
    passed: hits.length === 0,
    detail: hits.length
      ? `${hits.length} frozen segment(s) starting at ` +
        hits.map((t) => `${t.toFixed(2)}s`).join(", ")
      : "no frozen segments ≥2s",
    measured: { segments: hits.length },
  });
}

/** Samples frames for the multimodal reviewer (PRD §5 Layer 2). */
export async function sampleFrames(
  path: string,
  outDir: string,
  opts: { fps?: number; scaleWidth?: number } = {},
): Promise<string[]> {
  const { fps = 1, scaleWidth = 540 } = opts;
  await exec("ffmpeg", [
    "-hide_banner", "-nostats", "-y", "-i", path,
    "-vf", `fps=${fps},scale=${scaleWidth}:-2`,
    "-q:v", "3", `${outDir}/frame_%04d.jpg`,
  ], { maxBuffer: 1024 * 1024 * 16 });
  const { stdout } = await exec("sh", ["-c", `ls ${outDir}/frame_*.jpg`]);
  return stdout.trim().split("\n").filter(Boolean);
}
