import { join } from "node:path";
import { cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { planBeats, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
export { planBeats, BEAT_PAD_FRAMES, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
import {
  compose,
  availableHostPoses,
  HOST_POSE_DIR,
  type ComposeOptions,
  type ComposeResult,
} from "./compose.js";
import { render, type RenderOptions, type RenderQuality } from "./render.js";
import type { WordTiming, CaptionHighlight } from "./captions.js";
import { transcribeVoiceover } from "./transcribe.js";
import { wordsSidecarPath } from "../tts/elevenlabs.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";

/**
 * The HyperFrames edit agent — the headless replacement for
 * `build-timeline.ts`'s live-Palmier orchestration (PRD §4).
 *
 * Same audio-first contract: `planBeats` lays out every boundary from
 * measured VO durations before anything else runs. What changes is *how* a
 * timeline becomes pixels: `compose()` writes a directory of text files
 * (HTML + staged assets) instead of driving a desktop app over MCP, and
 * `render()` shells out to a CLI that runs to completion or fails loudly
 * instead of a job queue that must be polled.
 */

export interface BuildResult {
  plan: BeatPlan[];
  totalFrames: number;
  exportPath: string;
  checkpointPath: string;
  projectDir: string;
}

export interface BuildOptions {
  script: ScriptJSON;
  manifest: AssetManifest;
  workspace: { root: string; exports: string; checkpoints: string };
  /** Music bed level under the VO, in dB. See compose.ts for the default. */
  musicDuckDb?: number;
  /**
   * Adjustments applied by the review loop (src/review/directives.ts). Absent
   * on the first build; populated from the reviewer's fix list thereafter.
   */
  overrides?: BuildOverrides;
  /** Active-word caption treatment: yellow word ("pop") or red plate ("block"). */
  captionHighlight?: CaptionHighlight;
  /** Layout — see ComposeOptions.style. Default "classic". */
  style?: "classic" | "studio";
  /** Studio: brand text in the chrome bar. */
  brand?: string;
  /** Studio: render only the first N seconds (Gate-2 hook render). */
  maxSeconds?: number;
  /** Output file name override (default `<run_id>-v<iteration>.mp4`). */
  exportName?: string;
  /**
   * 1-based iteration number. Used both to name the checkpoint (so a run's
   * history is a readable sequence of directory diffs) and to pick render
   * quality: every iteration but the final master renders "draft".
   */
  iteration: number;
  /**
   * True only when the caller already knows this build IS the final master
   * (e.g. m1.ts's single-pass smoke run). Forces `quality: "high"`.
   *
   * The review loop can NOT know this in advance — it does not know which
   * iteration will pass until after building it — so every loop iteration
   * builds at "draft" regardless of this flag, and the loop instead calls
   * `renderFinalMaster` on the WINNING iteration's checkpoint once it is
   * known. Do not infer this from iteration count.
   */
  final?: boolean;
  onProgress?: (message: string) => void;
}

/** Injectable seam so `build()`'s own orchestration (ordering, naming,
 *  quality selection) is testable without touching the filesystem, a real
 *  `hyperframes` CLI, or a real project directory. Every field defaults to
 *  the real implementation. */
export interface BuildDeps {
  wordTimingsFor: (
    beatId: string,
    voPath: string,
    voText: string,
    log: (message: string) => void,
  ) => Promise<WordTiming[]>;
  compose: (opts: ComposeOptions) => Promise<ComposeResult>;
  /** Recursive directory copy — the checkpoint step. */
  copyProject: (src: string, dest: string) => Promise<void>;
  render: (opts: RenderOptions) => Promise<string>;
}

/**
 * A HyperFrames project is a directory of text files, not a binary `.palmier`
 * package, so a checkpoint is a recursive directory copy — which makes "what
 * changed between iteration 2 and 3" a plain, readable diff instead of an
 * opaque blob comparison.
 */
export function checkpointPathFor(checkpointsDir: string, runId: string, iteration: number): string {
  return join(checkpointsDir, `${runId}-v${iteration}`);
}

/**
 * Word timings for one beat's VO file, via `transcribeVoiceover`.
 *
 * `alignWords` (captions.ts) already falls back to distributing words evenly
 * across the measured VO duration when it receives no timings — that is
 * SPECIFIED behavior, not a silent degrade. What must never be silent is
 * WHICH beats are running on estimated rather than measured timing, so every
 * fallback path here logs loudly before returning an empty array.
 */
/**
 * Emits a degraded-captions alarm on BOTH the caller's progress channel and
 * `console.warn`, unconditionally. `onProgress` is optional everywhere it is
 * threaded through (m1.ts, the review loop), so a quality alarm that only
 * reached it could be silenced by simply not passing a callback. `console.warn`
 * cannot be omitted by a caller.
 */
function warnLoudly(message: string, log: (message: string) => void): void {
  log(message);
  console.warn(`[edit/build] ${message}`);
}

export async function wordTimingsForBeat(
  beatId: string,
  voPath: string,
  voText: string,
  log: (message: string) => void,
  transcribe: (voPath: string, voText: string) => Promise<WordTiming[]> = transcribeVoiceover,
): Promise<WordTiming[]> {
  // Timings measured by the TTS itself (ElevenLabs with-timestamps) beat any
  // transcription: they describe the exact audio file, and need no network.
  const sidecar = wordsSidecarPath(voPath);
  if (existsSync(sidecar)) {
    try {
      const fromTts = JSON.parse(await readFile(sidecar, "utf8")) as WordTiming[];
      if (Array.isArray(fromTts) && fromTts.length > 0) return fromTts;
    } catch (err) {
      log(`  ${beatId}: unreadable ${sidecar} (${(err as Error).message}); falling back to whisper`);
    }
  }
  let timings: WordTiming[];
  try {
    timings = await transcribe(voPath, voText);
  } catch (err) {
    warnLoudly(
      `CAPTIONS DEGRADED for beat "${beatId}": transcribe failed on "${voPath}" ` +
        `(${(err as Error).message}). Falling back to timings ESTIMATED by even ` +
        `word distribution — this is expected fallback behavior, not a bug, but ` +
        `the resulting captions will not track the actual audio precisely.`,
      log,
    );
    return [];
  }
  if (timings.length === 0) {
    warnLoudly(
      `CAPTIONS DEGRADED for beat "${beatId}": transcribe returned no words for ` +
        `"${voPath}". Falling back to timings ESTIMATED by even word distribution.`,
      log,
    );
  }
  return timings;
}

const defaultDeps: BuildDeps = {
  wordTimingsFor: wordTimingsForBeat,
  compose,
  copyProject: (src, dest) => cp(src, dest, { recursive: true }),
  render,
};

export async function build(opts: BuildOptions, deps: Partial<BuildDeps> = {}): Promise<BuildResult> {
  const { script, manifest, workspace } = opts;
  const log = opts.onProgress ?? (() => {});
  const { wordTimingsFor, compose: composeFn, copyProject, render: renderFn } = {
    ...defaultDeps,
    ...deps,
  };

  const plan = planBeats(script, manifest);
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to build");

  // 1. Word timings, per beat, from the beat's own measured VO file. Isolated
  //    behind wordTimingsForBeat so a transcribe outage degrades captions for
  //    that beat rather than failing the whole build.
  const wordTimings = new Map<string, WordTiming[]>();
  for (const p of plan) {
    wordTimings.set(p.beatId, await wordTimingsFor(p.beatId, p.voPath, p.voText, log));
  }

  // 2. Compose: writes the renderable project directory (HTML + staged
  //    assets). Same beat-keyed staging, same tuned constants as
  //    build-timeline.ts — see compose.ts's module comment for the parity
  //    notes deferred to the Task 8 check.
  const projectDir = join(workspace.root, "edit", script.run_id);
  const composed = await composeFn({
    plan,
    manifest,
    projectDir,
    runId: script.run_id,
    musicDuckDb: opts.musicDuckDb,
    overrides: opts.overrides,
    wordTimings,
    captionHighlight: opts.captionHighlight,
    style: opts.style,
    brand: opts.brand,
    maxSeconds: opts.maxSeconds,
    hostPoses: opts.style === "studio" ? availableHostPoses(HOST_POSE_DIR) : undefined,
  });
  log(`composed project at ${composed.projectDir} (${composed.totalSeconds}s)`);

  // 3. Checkpoint BEFORE rendering, so a bad review iteration can be rolled
  //    back to a known-good state (PRD §4) — mirrors build-timeline.ts's
  //    export-before-render checkpoint, but as a directory copy. Ordering
  //    matters: a checkpoint taken AFTER a failed render would preserve
  //    nothing worth rolling back to.
  const checkpointPath = checkpointPathFor(workspace.checkpoints, script.run_id, opts.iteration);
  await copyProject(projectDir, checkpointPath);
  log(`checkpointed project to ${checkpointPath}`);

  // 4. Render. Draft quality for review iterations keeps the loop cheap;
  //    the final master alone pays for a high-quality encode. Explicit at
  //    the call site via `opts.final`, not inferred from iteration count —
  //    and NEVER inferred by the review loop, which cannot know in advance
  //    which iteration will win (see `renderFinalMaster` below).
  const quality: RenderQuality = opts.final ? "high" : "draft";
  const exportPath = join(workspace.exports, opts.exportName ?? `${script.run_id}-v${opts.iteration}.mp4`);
  await renderFn({
    projectDir,
    outputPath: exportPath,
    quality,
    onProgress: (line) => log(`  render: ${line}`),
  });
  log(`rendered (${quality}) to ${exportPath}`);

  return {
    plan,
    totalFrames,
    exportPath,
    checkpointPath,
    projectDir,
  };
}

export interface RenderFinalMasterOptions {
  /** The winning iteration's checkpoint — a full copy of the exact project
   *  directory that iteration composed, taken before it was ever rendered. */
  checkpointPath: string;
  exportPath: string;
  onProgress?: (message: string) => void;
}

/**
 * Re-renders the review loop's WINNING iteration at publish quality.
 *
 * Every loop iteration renders "draft" (see `build`'s `final` doc) because
 * the loop cannot know in advance which iteration will pass. Once it does
 * know, the composition that iteration used is not gone — it is sitting in
 * that iteration's checkpoint directory, untouched since it was copied there
 * before that iteration's own (draft) render. Producing the actual master is
 * therefore a RENDER call against that checkpoint, not a rebuild: nothing
 * about the composition changes, only the encode settings.
 */
export async function renderFinalMaster(
  opts: RenderFinalMasterOptions,
  renderFn: (opts: RenderOptions) => Promise<string> = render,
): Promise<string> {
  const log = opts.onProgress ?? (() => {});
  log(`re-rendering the winning iteration at high quality from checkpoint ${opts.checkpointPath}`);
  await renderFn({
    projectDir: opts.checkpointPath,
    outputPath: opts.exportPath,
    quality: "high",
    onProgress: (line) => log(`  render: ${line}`),
  });
  log(`high-quality master rendered to ${opts.exportPath}`);
  return opts.exportPath;
}
