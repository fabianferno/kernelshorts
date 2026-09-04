import { join } from "node:path";
import { cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { planBeats, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
export { planBeats, BEAT_PAD_FRAMES, type BeatPlan, type BuildOverrides } from "./plan-beats.js";
import { compose } from "./compose.js";
import { render, type RenderQuality } from "./render.js";
import type { WordTiming } from "./captions.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";

const execFileAsync = promisify(execFile);

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
  /**
   * 1-based iteration number. Used both to name the checkpoint (so a run's
   * history is a readable sequence of directory diffs) and to pick render
   * quality: every iteration but the final master renders "draft".
   */
  iteration: number;
  /** True only for the run's final master. Forces `quality: "high"`. */
  final?: boolean;
  onProgress?: (message: string) => void;
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
 * THE ONLY PLACE THIS MODULE SHELLS OUT TO THE TRANSCRIBE CLI.
 *
 * Isolated on purpose: `hyperframes transcribe` is not installed on this
 * machine, so this function cannot be exercised for real here. Keeping it as
 * a single narrow seam means everything downstream (`wordTimingsForBeat`,
 * `build`) is testable by injecting a fake instead of stubbing `execFile`.
 *
 * Expected CLI contract (from the HyperFrames CLI reference): `hyperframes
 * transcribe <audioPath> --json` on stdout emits `{ words: [{ word, startS,
 * endS }, ...] }`.
 */
export async function transcribeVoiceover(voPath: string): Promise<WordTiming[]> {
  const { stdout } = await execFileAsync("npx", ["hyperframes", "transcribe", voPath, "--json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    words?: Array<{ word: string; startS: number; endS: number }>;
  };
  return (parsed.words ?? []).map((w) => ({ word: w.word, startS: w.startS, endS: w.endS }));
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
export async function wordTimingsForBeat(
  beatId: string,
  voPath: string,
  log: (message: string) => void,
  transcribe: (voPath: string) => Promise<WordTiming[]> = transcribeVoiceover,
): Promise<WordTiming[]> {
  let timings: WordTiming[];
  try {
    timings = await transcribe(voPath);
  } catch (err) {
    log(
      `CAPTIONS DEGRADED for beat "${beatId}": transcribe failed on "${voPath}" ` +
        `(${(err as Error).message}). Falling back to timings ESTIMATED by even ` +
        `word distribution — this is expected fallback behavior, not a bug, but ` +
        `the resulting captions will not track the actual audio precisely.`,
    );
    return [];
  }
  if (timings.length === 0) {
    log(
      `CAPTIONS DEGRADED for beat "${beatId}": transcribe returned no words for ` +
        `"${voPath}". Falling back to timings ESTIMATED by even word distribution.`,
    );
  }
  return timings;
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const { script, manifest, workspace } = opts;
  const log = opts.onProgress ?? (() => {});

  const plan = planBeats(script, manifest);
  const totalFrames = plan.at(-1)?.endFrame ?? 0;
  if (totalFrames === 0) throw new Error("Empty beat plan — nothing to build");

  // 1. Word timings, per beat, from the beat's own measured VO file. Isolated
  //    behind wordTimingsForBeat so a transcribe outage degrades captions for
  //    that beat rather than failing the whole build.
  const wordTimings = new Map<string, WordTiming[]>();
  for (const p of plan) {
    wordTimings.set(p.beatId, await wordTimingsForBeat(p.beatId, p.voPath, log));
  }

  // 2. Compose: writes the renderable project directory (HTML + staged
  //    assets). Same beat-keyed staging, same tuned constants as
  //    build-timeline.ts — see compose.ts's module comment for the parity
  //    notes deferred to the Task 8 check.
  const projectDir = join(workspace.root, "edit", script.run_id);
  const composed = await compose({
    plan,
    manifest,
    projectDir,
    runId: script.run_id,
    musicDuckDb: opts.musicDuckDb,
    overrides: opts.overrides,
    wordTimings,
  });
  log(`composed project at ${composed.projectDir} (${composed.totalSeconds}s)`);

  // 3. Checkpoint BEFORE rendering, so a bad review iteration can be rolled
  //    back to a known-good state (PRD §4) — mirrors build-timeline.ts's
  //    export-before-render checkpoint, but as a directory copy.
  const checkpointPath = checkpointPathFor(workspace.checkpoints, script.run_id, opts.iteration);
  await cp(projectDir, checkpointPath, { recursive: true });
  log(`checkpointed project to ${checkpointPath}`);

  // 4. Render. Draft quality for review iterations keeps the loop cheap;
  //    the final master alone pays for a high-quality encode. Explicit at
  //    the call site via `opts.final`, not inferred from iteration count.
  const quality: RenderQuality = opts.final ? "high" : "draft";
  const exportPath = join(workspace.exports, `${script.run_id}-v${opts.iteration}.mp4`);
  await render({
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
