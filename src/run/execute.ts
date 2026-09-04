import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runResearchPhase, ResearchEscalation } from "../phases/research.js";
import { deliver } from "../phases/deliver.js";
import { runReviewLoop } from "../review/loop.js";
import { createWorkspace, initState, loadState, setPhase, saveState, emit } from "./workspace.js";
import { waitForGate, supersedeOlderGates, getGate } from "./gates.js";
import { notify } from "../notify/push.js";
import { config } from "../config.js";
import { RunState, type AssetManifest, type ScriptJSON } from "../shared/schemas.js";

/**
 * One run, end to end: HN topic → research → Gate A → edit → review loop → a
 * finished 9:16 short in ~/pipeline/out.
 *
 * This is the pipeline as a CALLABLE, extracted from the old src/pipeline.ts so
 * that the long-running server (src/server.ts) and the one-shot CLI drive the
 * exact same code. The previous shape — a top-level script that read argv and
 * set process.exitCode — could only ever be run by a human typing a command,
 * which is what forced `--resume` to exist as a second command.
 *
 * It never calls process.exit and never throws for an ordinary bad outcome: a
 * rejected gate and a failed phase are both RESULTS, because a daemon that
 * takes a stack trace for a human saying "no" would die once a day.
 *
 * Publishing is deliberately NOT here. Automated upload is deferred to the end
 * of the project, so a run ends by handing a human a file and the copy to go
 * with it (Gate C), not by posting anything.
 */

export const DEFAULT_VOICE = "Fabian";
export const TARGET_DURATION_S = 45;

export interface ExecuteRunOptions {
  /** Soniox voice name or clone UUID. */
  voice?: string;
  /**
   * Skip research and edit the script already approved on disk. The edit phase
   * is the expensive, fragile half, and a crash there should not cost another
   * research pass and another set of TTS calls.
   */
  resume?: boolean;
  /** Defaults to today's `hn-<date>`. */
  runId?: string;
  dateSlug?: string;
  onProgress?: (message: string) => void;
}

export type ExecuteRunResult =
  | { status: "delivered"; runId: string; outPath: string; outDir: string; escalated: boolean; reason?: string }
  /** A human said no, or a newer run overtook this one. Not an error. */
  | { status: "stopped"; runId: string; reason: string }
  /** Fact-check failed; the script needs a human before anything is cut. */
  | { status: "escalated"; runId: string; reason: string }
  | { status: "failed"; runId: string; phase: string; reason: string };

export function todayRunId(slug: string): string {
  return `hn-${slug}`;
}

/**
 * Finds a run that started but never reached a terminal state — the thing the
 * old `--resume` flag made a human identify and type out.
 *
 * Three conditions, and each one rules out a way this could waste money or
 * surprise someone on boot:
 *
 *  - script AND manifest on the record — otherwise research never finished and
 *    there is nothing on disk worth salvaging; starting fresh is the honest
 *    move, not half-resuming into an inconsistent state.
 *  - Gate A actually APPROVED, read from the approvals collection rather than
 *    the state.gate_a mirror. The mirror is written AFTER the wait returns, so
 *    a run that died between the approval and that write looked unapproved
 *    forever — which is exactly what happened when approving a gate with no
 *    comment threw and killed the waiting run, stranding a finished script,
 *    six voiceover files and seven assets that only needed an edit.
 *  - not phase "publish"/"done" — those are terminal. "failed" IS resumable
 *    when the work above survived: that is the definition of resuming from
 *    where it broke instead of paying for all of it again.
 *
 * The Gate A condition is load-bearing: without it, booting the server pointed
 * at a workspace holding an old un-approved run would immediately start an
 * expensive edit nobody asked for.
 */
export async function findResumableRun(): Promise<RunState | undefined> {
  if (!existsSync(config.paths.runsRoot)) return undefined;
  const slugs = (await readdir(config.paths.runsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  for (const slug of slugs) {
    const statePath = join(config.paths.runsRoot, slug, "state.json");
    if (!existsSync(statePath)) continue;
    let state: RunState;
    try {
      state = RunState.parse(JSON.parse(await readFile(statePath, "utf8")));
    } catch {
      // A malformed state file is not a reason to refuse to boot. Skip it.
      continue;
    }
    // "publish" means the video is finished and waiting at Gate C, "done" means
    // it went out, "failed" means a human should look — none of them are work
    // left to finish. Everything else was interrupted mid-flight.
    if (["publish", "done"].includes(state.phase)) continue;
    if (!state.script || !state.manifest) continue;
    const gate = await getGate(state.run_id, "A_script");
    if (gate?.status !== "approved") continue;
    return state;
  }
  return undefined;
}

export async function executeRun(opts: ExecuteRunOptions = {}): Promise<ExecuteRunResult> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const slug = opts.dateSlug ?? new Date().toISOString().slice(0, 10);
  const runId = opts.runId ?? todayRunId(slug);
  const log = opts.onProgress ?? (() => {});
  const ws = await createWorkspace(runId, slug);

  let state = opts.resume ? await loadState(ws) : undefined;
  if (opts.resume && !state) {
    return {
      status: "failed",
      runId,
      phase: "research",
      reason:
        `resume found no state at ${ws.statePath}. There is nothing to resume; ` +
        `start a new run instead.`,
    };
  }
  state ??= await initState(ws);

  log(`run: ${runId}\nworkspace: ${ws.root}\nvoice: ${voice}\n`);

  let script: ScriptJSON;
  let manifest: AssetManifest;
  let topicUrl: string;
  let hnId: number | undefined;
  let unsourcedLines: string[] | undefined;

  try {
    if (opts.resume) {
      if (!state.script || !state.manifest) {
        return {
          status: "failed",
          runId,
          phase: state.phase,
          reason:
            `resume: run ${runId} has no script/manifest on its state record. The ` +
            `research phase never finished, so there is nothing approved to edit.`,
        };
      }
      script = state.script;
      manifest = state.manifest;
      topicUrl = script.topic.url;
      hnId = script.topic.hn_id;
      log(`resuming with the approved script: ${script.topic.title}`);
    } else {
      await supersedeOlderGates(runId);
      const research = await runResearchPhase({
        runId,
        ws,
        state,
        voice,
        targetDurationS: TARGET_DURATION_S,
        onProgress: log,
        /**
         * The daemon can wait, so an escalated Gate A is a question, not an
         * exit. Previously the run threw here: the gate was opened for a human
         * and the process was gone before they answered, so their approval
         * landed in Mongo and did nothing.
         *
         * Approving means "narrate it anyway" — the flagged lines ride through
         * to Gate C so the decision is visible again before publishing.
         */
        onEscalation: async (info) => {
          log(
            `\nFACT-CHECK ESCALATED — Gate A is open with ${info.problems.length} ` +
              `unsourced line(s). Approve to narrate them anyway, reject to stop:\n` +
              info.problems.join("\n"),
          );
          const decision = await waitForGate(runId, "A_script", {
            onWait: (elapsed) => {
              if (elapsed >= 60_000 && elapsed % 60_000 < 5_000) {
                log(`  Gate A (escalated) still open (${Math.round(elapsed / 60_000)}m)`);
              }
            },
          });
          return decision.status === "approved";
        },
      });
      state = research.state;
      script = research.script;
      manifest = research.manifest;
      topicUrl = research.story.url ?? research.story.hn_url;
      hnId = research.story.id;
      unsourcedLines = research.unsourcedLines;
    }

    // ── Gate A: a human approves the script before a frame is cut. ──────────
    //
    // Awaiting here does not block the server: waitForGate polls with an
    // awaited timer, so the HTTP listener keeps serving and the dashboard stays
    // live while the run sits parked. That is the whole reason a gate no longer
    // needs a separate CLI to answer it.
    log(`\nwaiting for a human on Gate A…`);
    let lastLog = 0;
    const gateA = await waitForGate(runId, "A_script", {
      onWait: (elapsed) => {
        if (elapsed - lastLog >= 60_000 || lastLog === 0) {
          lastLog = elapsed;
          log(`  Gate A still open (${Math.round(elapsed / 60_000)}m)`);
        }
      },
    });
    state = await saveState(ws, {
      ...state,
      gate_a: {
        status: gateA.status,
        comment: gateA.comment,
        resolved_at: gateA.resolved_at,
      },
    });

    if (gateA.status !== "approved") {
      const why =
        gateA.status === "rejected"
          ? `Gate A rejected${gateA.comment ? `: ${gateA.comment}` : ""}`
          : `Gate A superseded by a newer run — this run was overtaken, not approved`;
      await emit(runId, "script", "gate_closed", why);
      await notify({ title: `Run ${runId} stopped`, body: why });
      await saveState(ws, { ...state, phase: "failed", blocked_on: why });
      log(`\n${why}`);
      return { status: "stopped", runId, reason: why };
    }

    log(`\n=== GATE A APPROVED ===` + (gateA.comment ? `\ncomment: ${gateA.comment}` : ""));
    // An approve-with-comment is a real instruction from a human (PRD §2), and
    // the review loop cannot read it — its directive vocabulary is closed.
    // Rather than silently dropping it, it goes on the record and is shown
    // again at Gate C so the person publishing sees whether it was addressed.
    if (gateA.comment) {
      await emit(runId, "edit", "log", `Gate A comment carried to Gate C: ${gateA.comment}`);
    }

    // ── Edit + review loop (M1 + M2). Renders headlessly, no client needed. ─
    state = await setPhase(ws, state, "edit");
    const outcome = await runReviewLoop({
      script,
      manifest,
      workspace: ws,
      onProgress: log,
    });

    log(`\n=== REVIEW ${outcome.status.toUpperCase()} ===`);
    for (const it of outcome.iterations) {
      const failed = it.layer1.filter((r) => !r.passed).map((r) => r.name);
      log(
        `  #${it.index} mean ${it.meanScore.toFixed(2)}` +
          ` L1 ${it.layer1.length - failed.length}/${it.layer1.length}` +
          (failed.length ? ` FAILED: ${failed.join(",")}` : ""),
      );
    }

    // ── Deliver: the file a human can actually pick up and post. ────────────
    state = await setPhase(ws, state, "export");
    const delivered = await deliver({
      runId,
      ws,
      script,
      masterPath: outcome.final.masterPath,
      reviewStatus: outcome.status,
      reviewNotes: outcome.status === "escalate" ? outcome.notes : undefined,
      gateAComment: gateA.comment,
      unsourcedLines,
      meanScore: outcome.final.meanScore,
      hnId,
      topicUrl,
      onProgress: log,
    });

    await saveState(ws, {
      ...state,
      iterations: outcome.iterations.length,
      exports: [...outcome.iterations.map((i) => i.masterPath), delivered.outPath],
      // The run is not "done" until a human has published it; publishing is
      // manual for now, so Gate C open IS the end state of an automated run.
      phase: "publish",
    });

    log(
      `\n=== READY TO PUBLISH ===\n` +
        `video:  ${delivered.outPath}\n` +
        `folder: ${delivered.outDir}\n` +
        `dashboard: run ${runId} → Gate C\n` +
        (outcome.status === "escalate"
          ? `\nNOTE: the review loop escalated (${outcome.reason}). The video is ` +
            `finished and playable, but it did not clear the rubric on its own — ` +
            `watch it before posting.\n`
          : ""),
    );

    return {
      status: "delivered",
      runId,
      outPath: delivered.outPath,
      outDir: delivered.outDir,
      escalated: outcome.status === "escalate",
      reason: outcome.status === "escalate" ? outcome.reason : undefined,
    };
  } catch (err) {
    if (err instanceof ResearchEscalation) {
      log(`\nESCALATED to Gate A — fact-check failed:\n${err.message}`);
      return { status: "escalated", runId, reason: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    await emit(runId, state.phase, "error", message);
    await saveState(ws, { ...state, phase: "failed", blocked_on: message });
    await notify({ title: `Run ${runId} FAILED`, body: `${state.phase}: ${message}` });
    log(`\nFAILED in phase "${state.phase}": ${message}`);
    return { status: "failed", runId, phase: state.phase, reason: message };
  }
}
