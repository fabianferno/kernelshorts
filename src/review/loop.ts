import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  build as buildHyperframes,
  renderFinalMaster,
  type BuildOptions as HFBuildOptions,
  type BeatPlan,
  type BuildOverrides,
} from "../edit/build.js";
import {
  checkContainer, checkLoudness, checkBlackFrames, checkFrozenFrames, normalizeLoudness,
} from "../verify/media.js";
import {
  checkTimelineGaps, checkCaptionSafeArea, checkScriptFidelity,
} from "../verify/timeline.js";
import { reviewVideo } from "./reviewer.js";
import { translateFixes, type DirectivePlan } from "./directives.js";
import {
  RUBRIC_KEYS, AssetManifest,
  type ScriptJSON, type RubricScore, type VerifierResult,
} from "../shared/schemas.js";
import { acquireStock } from "../assets/stock.js";
import { acquireGenerated } from "../assets/acquire.js";
import type { Workspace } from "../run/workspace.js";
import { putArtifact } from "../run/artifacts.js";

/**
 * The review loop (PRD §5).
 *
 * Each iteration: build → export → normalize → Layer 1 → Layer 2 → decide.
 *
 * Exit   — every Layer-1 check passes AND every rubric dimension >= 4.
 * Iterate— compile the reviewer's fixes into directives and rebuild.
 * Stop   — 4 iterations, or no improvement across 2 consecutive iterations,
 *          then escalate to Gate B with the video and the reviewer's notes.
 */

const MAX_ITERATIONS = 4;
const RUBRIC_PASS = 4;
const STALL_LIMIT = 2;

/**
 * Reviews are cheap (~10.5k input tokens for 33 frames, measured), but noisy:
 * the same frames scored a full point apart across prompt phrasings. A hard
 * >= 4 gate sits inside that noise band, so each iteration runs the reviewer
 * N times and takes the MEDIAN per dimension. This trades a few thousand
 * tokens for a decision that doesn't hinge on one sample.
 */
const REVIEW_SAMPLES = 3;

export interface LoopOptions {
  script: ScriptJSON;
  manifest: AssetManifest;
  workspace: Workspace;
  captionHighlight?: "block" | "pop";
  onProgress?: (message: string) => void;
}

export interface Iteration {
  index: number;
  exportPath: string;
  masterPath: string;
  /**
   * The build's checkpoint: a directory copy of the exact project this
   * iteration composed, taken before its (draft-quality) render —
   * `renderFinalMaster` re-renders it at "high" once the loop knows this is
   * the winning iteration.
   */
  checkpointPath?: string;
  layer1: VerifierResult[];
  rubric: RubricScore;
  /** Mean rubric score — the scalar used to detect stalling. */
  meanScore: number;
  directives?: DirectivePlan;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
}

export type LoopOutcome =
  | { status: "passed"; iterations: Iteration[]; final: Iteration }
  | {
      status: "escalate";
      reason: "max_iterations" | "no_improvement" | "unaddressable_fixes";
      iterations: Iteration[];
      final: Iteration;
      notes: string;
    };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Combines N independent reviews into one rubric by taking the median score per
 * dimension, keeping the justification from the sample that scored the median,
 * and unioning the fix lists (deduped by timestamp+action).
 */
export function mergeReviews(samples: RubricScore[]): RubricScore {
  if (samples.length === 1) return samples[0]!;

  const scores = {} as RubricScore["scores"];
  for (const key of RUBRIC_KEYS) {
    const values = samples.map((s) => s.scores[key].score);
    const med = median(values);
    const representative =
      samples.find((s) => s.scores[key].score === med) ?? samples[0]!;
    scores[key] = {
      score: Math.round(med),
      justification: representative.scores[key].justification,
    };
  }

  const seen = new Set<string>();
  const fixes = samples
    .flatMap((s) => s.fixes)
    .filter((f) => {
      const key = `${Math.round(f.at_s)}|${f.action.slice(0, 40)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { scores, fixes };
}

/**
 * Layer-1 verifiers, run against the normalized publish master.
 *
 * Exported so callers can drive the REAL Layer-1 path the loop uses, rather
 * than a copy of it that could drift.
 */
export async function runLayer1(
  masterPath: string,
  script: ScriptJSON,
  log: (message: string) => void,
  plan: BeatPlan[],
  projectDir: string,
): Promise<VerifierResult[]> {
  const results: VerifierResult[] = [];
  for (const check of [checkContainer, checkLoudness, checkBlackFrames, checkFrozenFrames]) {
    results.push(await check(masterPath));
  }
  // The BEAT PLAN for gaps (no live project to read), and the composed
  // index.html measured in a real browser for the safe area. See
  // src/verify/timeline.ts.
  results.push(await checkTimelineGaps(plan));
  results.push(await checkCaptionSafeArea({ indexPath: join(projectDir, "index.html") }));
  results.push(await checkScriptFidelity(masterPath, script));
  return results;
}

/** Folds a directive plan into the build overrides for the next iteration. */
export function applyDirectives(
  base: BuildOverrides,
  plan: DirectivePlan,
): { overrides: BuildOverrides; musicDuckDb?: number } {
  const overrides: BuildOverrides = {
    ...base,
    beats: { ...(base.beats ?? {}) },
  };
  let musicDuckDb: number | undefined;

  for (const directive of plan.directives) {
    switch (directive.kind) {
      case "music_level":
        musicDuckDb = directive.db;
        break;
      case "caption_position":
        overrides.captionCenterY = directive.centerY;
        break;
      case "caption_size":
        overrides.captionFontSize = directive.fontSize;
        break;
      case "beat_trim":
        overrides.beats![directive.beat_id] = {
          ...overrides.beats![directive.beat_id],
          trimStartFrames: directive.trimStartFrames,
          trimEndFrames: directive.trimEndFrames,
        };
        break;
      case "beat_zoom":
        overrides.beats![directive.beat_id] = {
          ...overrides.beats![directive.beat_id],
          zoom: directive.zoom,
          centerY: directive.centerY,
        };
        break;
      case "overlay_treatment":
        overrides.beats![directive.beat_id] = {
          ...overrides.beats![directive.beat_id],
          treatment: directive.treatment,
        };
        break;
      case "beat_split":
        overrides.beats![directive.beat_id] = {
          ...overrides.beats![directive.beat_id],
          // Midpoint: the cut point is mechanical, not editorial.
          splitAt: 0.5,
        };
        break;
      case "replace_visual":
      case "generate_visual":
        // Handled by the orchestrator, which re-acquires footage and rebuilds
        // the manifest — the builder cannot download or render new media.
        break;
    }
  }

  return { overrides, musicDuckDb };
}

/**
 * Re-acquires footage for beats the reviewer said do not match their narration.
 *
 * The builder cannot do this — it only assembles what the manifest already
 * points at — so the orchestrator fetches new stock (replace_visual) or renders
 * a scene (generate_visual) and hands the next iteration an updated manifest. Failures here are reported and skipped rather
 * than aborting the loop: losing one replacement is not worth discarding an
 * otherwise-improving iteration, and the beat keeps its existing footage.
 */
async function reacquireVisuals(
  manifest: AssetManifest,
  plan: DirectivePlan,
  script: ScriptJSON,
  workspaceRoot: string,
  log: (m: string) => void,
): Promise<AssetManifest> {
  const replacements = plan.directives.filter(
    (d) => d.kind === "replace_visual" || d.kind === "generate_visual",
  );
  if (replacements.length === 0) return manifest;

  const assets = [...manifest.assets];
  for (const directive of replacements) {
    if (directive.kind !== "replace_visual" && directive.kind !== "generate_visual") continue;
    const index = assets.findIndex((a) => a.beat_id === directive.beat_id);
    if (index === -1) continue;

    const vo = manifest.voiceover.find((v) => v.beat_id === directive.beat_id);
    const beat = script.beats.find((b) => b.id === directive.beat_id);
    const neededS = vo?.durationS ?? beat?.max_duration_s ?? 5;
    const what =
      directive.kind === "replace_visual"
        ? `stock "${directive.stock_query}"`
        : `generated "${directive.spec.scene}" scene`;

    try {
      // Both paths write into <workspace>/assets under the beat id, so the
      // replacement overwrites whatever the beat had — including a swap
      // between a stock clip and a rendered scene, which is the whole point.
      const replacement =
        directive.kind === "replace_visual"
          ? await acquireStock(
              { type: "stock", query: directive.stock_query, preferVault: true },
              { workspace: workspaceRoot, beatId: directive.beat_id, neededS },
            )
          : await acquireGenerated(directive.spec, workspaceRoot, directive.beat_id, neededS);
      assets[index] = replacement;
      log(`  re-acquired "${directive.beat_id}" footage: ${what}`);
    } catch (err) {
      log(
        `  re-acquisition FAILED for "${directive.beat_id}" ` +
          `(${what}): ${(err as Error).message} — keeping existing footage`,
      );
    }
  }

  return AssetManifest.parse({ ...manifest, assets });
}

/**
 * Writes the iteration's verdict where the dashboard can read it.
 *
 * The loop used to keep every rubric in memory and return them at the end, so
 * the one artifact that explains WHY a video passed or escalated existed only
 * in a terminal that had already scrolled. The review loop is also the run's
 * expensive phase (PRD §8), which makes its per-iteration scores the numbers
 * most worth keeping across runs.
 *
 * Persisted per iteration rather than at the end on purpose: a run that crashes
 * on iteration 3 should still show what iterations 1 and 2 scored.
 */
async function persistIteration(
  runId: string,
  workspace: Workspace,
  iteration: Iteration,
): Promise<void> {
  const path = join(workspace.checkpoints, `rubric-${iteration.index}.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        index: iteration.index,
        meanScore: iteration.meanScore,
        scores: iteration.rubric.scores,
        fixes: iteration.rubric.fixes,
        layer1: iteration.layer1,
        directives: iteration.directives,
        masterPath: iteration.masterPath,
        inputTokens: iteration.inputTokens,
        outputTokens: iteration.outputTokens,
        wallClockMs: iteration.wallClockMs,
      },
      null,
      2,
    ),
  );
  // Never fatal. A run that produced a good video must not be failed by the
  // bookkeeping that describes it.
  await putArtifact(runId, path, {
    kind: "rubric",
    phase: "review",
    label: `iteration ${iteration.index} — mean ${iteration.meanScore.toFixed(2)}`,
  }).catch((err) => console.warn(`[review] could not store rubric artifact: ${err}`));
}

/**
 * Builds the argument object for the hyperframes `build()` call from the
 * loop's own options and per-iteration state.
 *
 * Pulled out as its own function so the plumbing from `LoopOptions.captionHighlight`
 * (which the loop RECEIVES) into the hyperframes build call (which needs it
 * to pick a caption treatment) is directly testable — the gap that shipped
 * previously was here, in this assembly, not in `compose()`'s handling of a
 * value it was actually given.
 */
export function hyperframesBuildArgs(
  opts: Pick<LoopOptions, "script" | "manifest" | "workspace" | "captionHighlight">,
  iteration: number,
  overrides: BuildOverrides,
  musicDuckDb: number | undefined,
): HFBuildOptions {
  return {
    script: opts.script,
    manifest: opts.manifest,
    workspace: opts.workspace,
    overrides,
    captionHighlight: opts.captionHighlight,
    iteration,
    ...(musicDuckDb !== undefined ? { musicDuckDb } : {}),
  };
}

/**
 * Upgrades the loop's WINNING iteration to a publish-quality master.
 *
 * Every iteration renders "draft" (build.ts's `build` cannot render "high"
 * mid-loop — it does not know in advance which iteration will win). Once the
 * loop knows, this re-renders that iteration's checkpoint at "high" and
 * re-normalizes the result into the SAME `masterPath` the rest of the
 * pipeline already references, so nothing downstream (Gate B/C, deliver)
 * needs to know this happened. A no-op for any iteration whose checkpoint is
 * missing.
 */
async function finalizeMaster(
  outcome: LoopOutcome,
  workspace: Workspace,
  script: ScriptJSON,
  log: (message: string) => void,
): Promise<LoopOutcome> {
  const { checkpointPath, masterPath } = outcome.final;
  if (!checkpointPath) return outcome;

  log(`  finalizing master: re-rendering iteration ${outcome.final.index} at high quality`);
  const highQualityExport = join(workspace.exports, `${script.run_id}-final-master-raw.mp4`);
  await renderFinalMaster({
    checkpointPath,
    exportPath: highQualityExport,
    onProgress: (m) => log(`    ${m}`),
  });
  // The draft render was already loudness-normalized into `masterPath`; the
  // fresh high-quality encode needs the same treatment before it can replace
  // it as the file everything downstream reads.
  await normalizeLoudness(highQualityExport, masterPath);
  log(`  master upgraded to high quality at ${masterPath}`);
  return outcome;
}

export async function runReviewLoop(opts: LoopOptions): Promise<LoopOutcome> {
  const { script, workspace } = opts;
  let manifest = opts.manifest;
  const log = opts.onProgress ?? (() => {});

  const iterations: Iteration[] = [];
  let overrides: BuildOverrides = {};
  let musicDuckDb: number | undefined;
  let stalls = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const started = Date.now();
    log(`iteration ${i + 1}/${MAX_ITERATIONS}: building`);

    const build = await buildHyperframes({
      ...hyperframesBuildArgs(opts, i + 1, overrides, musicDuckDb),
      onProgress: (m) => log(`  build: ${m}`),
    });

    const masterPath = join(workspace.exports, `${script.run_id}-v${i + 1}-master.mp4`);
    await normalizeLoudness(build.exportPath, masterPath);

    const layer1 = await runLayer1(masterPath, script, log, build.plan, build.projectDir);
    const layer1Passed = layer1.every((r) => r.passed);
    log(
      `  layer 1: ${layer1.filter((r) => r.passed).length}/${layer1.length} passed` +
        (layer1Passed ? "" : ` — ${layer1.filter((r) => !r.passed).map((r) => r.name).join(", ")}`),
    );

    // Layer 2 runs regardless: even when Layer 1 fails we want the reviewer's
    // fixes, so one iteration can address both classes of problem.
    let inputTokens = 0;
    let outputTokens = 0;
    const samples: RubricScore[] = [];
    for (let s = 0; s < REVIEW_SAMPLES; s++) {
      const review = await reviewVideo({
        videoPath: masterPath,
        script,
        workspace: workspace.root,
        voiceover: manifest.voiceover.map((v) => ({
          beat_id: v.beat_id,
          durationS: v.durationS,
        })),
      });
      samples.push(review.rubric);
      inputTokens += review.inputTokens;
      outputTokens += review.outputTokens;
    }
    const rubric = mergeReviews(samples);

    // caption_legibility is geometry, not taste: the deterministic safe-area
    // verifier owns it. A vision model guessing at whether text clears the
    // platform UI bands is strictly worse than measuring the boxes.
    // caption_safe_area comes from a browser measurement of the composed
    // project, and runLayer1 always produces it, so this clamp always runs —
    // there is no "unmeasured guess" path left to fall back to.
    const safeArea = layer1.find((r) => r.name === "caption_safe_area");
    if (!safeArea) {
      throw new Error(
        `Layer 1 produced no caption_safe_area result — caption_legibility would ` +
          `stand as the vision model's unmeasured guess. Refusing to score it.`,
      );
    }
    rubric.scores.caption_legibility = {
      score: safeArea.passed ? Math.max(rubric.scores.caption_legibility.score, 4) : 2,
      justification: `Safe-area verifier: ${safeArea.detail}`,
    };

    const scores = RUBRIC_KEYS.map((k) => rubric.scores[k].score);
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const rubricPassed = scores.every((s) => s >= RUBRIC_PASS);
    log(
      `  layer 2: mean ${meanScore.toFixed(2)} — ` +
        RUBRIC_KEYS.map((k) => `${k} ${rubric.scores[k].score}`).join(", "),
    );

    const iteration: Iteration = {
      index: i + 1,
      exportPath: build.exportPath,
      masterPath,
      checkpointPath: build.checkpointPath,
      layer1,
      rubric,
      meanScore,
      inputTokens,
      outputTokens,
      wallClockMs: Date.now() - started,
    };
    iterations.push(iteration);
    await persistIteration(script.run_id, workspace, iteration);

    if (layer1Passed && rubricPassed) {
      log(`  PASS on iteration ${i + 1}`);
      return finalizeMaster({ status: "passed", iterations, final: iteration }, workspace, script, log);
    }

    // Stall detection: no improvement in the mean across consecutive iterations.
    const previous = iterations[iterations.length - 2];
    if (previous && meanScore <= previous.meanScore) {
      stalls++;
      log(`  no improvement (${previous.meanScore.toFixed(2)} → ${meanScore.toFixed(2)}), stall ${stalls}/${STALL_LIMIT}`);
      if (stalls >= STALL_LIMIT) {
        return finalizeMaster(
          {
            status: "escalate",
            reason: "no_improvement",
            iterations,
            final: iteration,
            notes:
              `Score stopped improving across ${STALL_LIMIT} consecutive iterations ` +
              `(mean ${meanScore.toFixed(2)}). Lowest dimensions: ` +
              RUBRIC_KEYS.filter((k) => rubric.scores[k].score < RUBRIC_PASS)
                .map((k) => `${k} (${rubric.scores[k].score}): ${rubric.scores[k].justification}`)
                .join("; "),
          },
          workspace,
          script,
          log,
        );
      }
    } else {
      stalls = 0;
    }

    if (i === MAX_ITERATIONS - 1) break;

    const translated = await translateFixes({
      rubric,
      beatIds: script.beats.map((b) => b.id),
      current: {
        musicDb: musicDuckDb ?? -20,
        captionCenterY: overrides.captionCenterY ?? 0.72,
        captionFontSize: overrides.captionFontSize ?? 31,
      },
    });
    iteration.directives = translated.plan;
    iteration.inputTokens += translated.inputTokens;
    iteration.outputTokens += translated.outputTokens;

    const revisual = translated.plan.directives.filter(
      (d) => d.kind === "replace_visual" || d.kind === "generate_visual",
    );
    if (translated.plan.unaddressable.length > 0 && translated.plan.directives.length === 0) {
      return finalizeMaster(
        {
          status: "escalate",
          reason: "unaddressable_fixes",
          iterations,
          final: iteration,
          notes:
            `Every fix the reviewer asked for is outside what the builder can do:\n` +
            translated.plan.unaddressable.map((u) => `- ${u.at_s}s: ${u.action}`).join("\n"),
        },
        workspace,
        script,
        log,
      );
    }

    log(
      `  applying ${translated.plan.directives.length} directive(s)` +
        (translated.plan.unaddressable.length
          ? `, ${translated.plan.unaddressable.length} unaddressable`
          : "") +
        (revisual.length ? `, ${revisual.length} re-acquiring footage` : ""),
    );

    const applied = applyDirectives(overrides, translated.plan);
    overrides = applied.overrides;
    if (applied.musicDuckDb !== undefined) musicDuckDb = applied.musicDuckDb;

    manifest = await reacquireVisuals(manifest, translated.plan, script, workspace.root, log);
  }

  const final = iterations[iterations.length - 1]!;
  return finalizeMaster(
    {
      status: "escalate",
      reason: "max_iterations",
      iterations,
      final,
      notes:
        `Reached ${MAX_ITERATIONS} iterations without passing. Final scores: ` +
        RUBRIC_KEYS.map((k) => `${k} ${final.rubric.scores[k].score}`).join(", ") +
        `. Failing Layer-1 checks: ` +
        (final.layer1.filter((r) => !r.passed).map((r) => `${r.name} (${r.detail})`).join("; ") ||
          "none"),
    },
    workspace,
    script,
    log,
  );
}
