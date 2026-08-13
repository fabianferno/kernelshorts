import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config.js";
import { checkBlackFrames, checkFrozenFrames, probe, sampleFrames } from "../../verify/media.js";

const exec = promisify(execFile);

export interface ClipCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ClipVerification {
  passed: boolean;
  checks: ClipCheck[];
  width: number;
  height: number;
  fps: number;
  durationS: number;
}

/**
 * Mean absolute inter-frame luma difference, measured for real.
 *
 * `tblend=all_mode=difference` produces the delta between consecutive frames;
 * signalstats' YAVG on that stream is how much the picture changed. Measured
 * reference points on real renders: a `-loop 1` still clip reports max YAVG
 * 0.00, a rendered scene reports well above 0.2 even while "holding" (the
 * ambient drift in page.ts exists precisely to keep this non-zero).
 */
async function measureMotion(path: string): Promise<{ max: number; mean: number; frames: number }> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path,
     "-vf", "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
     "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 64 },
  );
  // The exponent MUST be part of the capture: on a genuinely static clip ffmpeg
  // prints values like 1.83256e-05, and a [\d.]+ pattern reads that as "1.83256"
  // — which is exactly how a still frame sailed through this check once.
  const vals = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.eE+-]+)/g)]
    .map((m) => Number(m[1]));
  if (vals.some((v) => !Number.isFinite(v))) {
    throw new Error(`Unparseable YAVG value while measuring motion for ${path}`);
  }
  if (!vals.length) throw new Error(`Could not measure inter-frame motion for ${path}`);
  return {
    max: Math.max(...vals),
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    frames: vals.length,
  };
}

/** Mean luma difference between two stills — the "did anything change at all"
 *  measure, independent of what happened frame to frame in between. */
async function frameDifference(a: string, b: string): Promise<number> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", a, "-i", b,
     "-filter_complex", "[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
     "-frames:v", "1", "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 * 8 },
  );
  const m = stderr.match(/lavfi\.signalstats\.YAVG=([\d.eE+-]+)/);
  if (!m) throw new Error(`Could not compare frames ${a} and ${b}`);
  return Number(m[1]);
}

/**
 * Verifies one generated clip against the same contract a screen recording has
 * to meet, plus the check that only generated scenes need: that the picture
 * actually moves. A scene that renders but never animates passes ffprobe,
 * blackdetect and (if it holds a full still) even reads as "fine" — it is the
 * exact failure this feature invites (PRD §4a), so it is checked explicitly.
 *
 * Throws on failure. There is no "warn and continue": a bad clip must not reach
 * the timeline.
 */
export async function verifyGeneratedClip(
  path: string,
  expectedDurationS: number,
): Promise<ClipVerification> {
  if (!(await stat(path)).size) throw new Error(`Generated clip ${path} is empty`);
  const p = await probe(path);
  const checks: ClipCheck[] = [];

  const { width, height, fps } = config.video;
  checks.push({
    name: "resolution",
    passed: p.width === width && p.height === height,
    detail: `${p.width}x${p.height} (expected ${width}x${height})`,
  });
  checks.push({
    name: "fps",
    passed: Math.abs(p.fps - fps) <= 0.5,
    detail: `${p.fps.toFixed(2)} fps (expected ${fps})`,
  });
  checks.push({
    name: "codec",
    passed: p.videoCodec === "h264",
    detail: `${p.videoCodec} (expected h264)`,
  });
  // ±0.15s: the trim is a keyframe-independent -t cut, so the container lands
  // within one or two frame durations of the requested length.
  const dErr = Math.abs(p.durationS - expectedDurationS);
  checks.push({
    name: "duration",
    passed: dErr <= 0.15,
    detail: `${p.durationS.toFixed(3)}s vs expected ${expectedDurationS.toFixed(3)}s (Δ${dErr.toFixed(3)}s)`,
  });

  const black = await checkBlackFrames(path);
  checks.push({ name: "blackdetect", passed: black.passed, detail: black.detail });
  const frozen = await checkFrozenFrames(path);
  checks.push({ name: "freezedetect", passed: frozen.passed, detail: frozen.detail });

  const motion = await measureMotion(path);
  // 0.05 mean YAVG is far below anything a real scene produces and far above
  // encoder noise on a genuinely static clip (measured 0.00 on -loop 1 stills).
  checks.push({
    name: "motion",
    passed: motion.mean >= 0.05 && motion.max >= 0.2,
    detail: `inter-frame YAVG mean ${motion.mean.toFixed(3)}, max ${motion.max.toFixed(3)} ` +
      `over ${motion.frames} frames (need mean ≥ 0.05, max ≥ 0.2)`,
  });

  // Second, independent witness — and a different question: the picture at the
  // END must differ from the picture at the START. Consecutive-frame difference
  // alone cannot tell a scene that genuinely progresses from one that jitters in
  // place. Comparing sampled JPEG file SIZES does not work: H.264 decode noise
  // makes every sampled frame of a `-loop 1` still clip a different size (9897
  // to 9903 bytes, all distinct), so sizes "prove" motion that isn't there.
  const dir = await mkdtemp(join(tmpdir(), "genframes-"));
  try {
    const frames = await sampleFrames(path, dir, { fps: 2, scaleWidth: 360 });
    if (frames.length < 2) {
      throw new Error(`Only ${frames.length} frame(s) sampled from ${path}`);
    }
    const drift = await frameDifference(frames[0]!, frames[frames.length - 1]!);
    checks.push({
      name: "frame-drift",
      passed: drift >= 0.5,
      detail: `first vs last sampled frame differ by mean luma ${drift.toFixed(3)} ` +
        `(need ≥ 0.5, across ${frames.length} samples)`,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length) {
    throw new Error(
      `Generated clip failed verification (${path}):\n` +
        failed.map((c) => `  ✗ ${c.name}: ${c.detail}`).join("\n"),
    );
  }
  return {
    passed: true, checks,
    width: p.width, height: p.height, fps: p.fps, durationS: p.durationS,
  };
}
