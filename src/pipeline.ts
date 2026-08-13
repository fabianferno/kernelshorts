import { runResearchPhase, ResearchEscalation } from "./phases/research.js";
import { deliver } from "./phases/deliver.js";
import { runReviewLoop } from "./review/loop.js";
import { PalmierClient } from "./palmier/client.js";
import { createWorkspace, initState, loadState, setPhase, saveState, emit } from "./run/workspace.js";
import { waitForGate, supersedeOlderGates } from "./run/gates.js";
import { notify } from "./notify/push.js";
import { closeDb } from "./db/mongo.js";
import type { AssetManifest, ScriptJSON } from "./shared/schemas.js";

/**
 * The whole day, end to end: HN topic → research → Gate A → edit → review loop
 * → a finished 9:16 short in ~/pipeline/out, visible in the dashboard.
 *
 * This is the piece that proves M1–M4 compose. Each milestone was verified on
 * its own with a real artifact, but "each stage works" and "the stages work in
 * sequence" are different claims, and only this one produces a video from a
 * topic nobody chose by hand.
 *
 * Publishing is deliberately NOT here. Automated upload is deferred to the end
 * of the project, so the run ends by handing a human a file and the copy to go
 * with it (Gate C), not by posting anything.
 *
 * Run:
 *   npx tsx src/pipeline.ts [voiceName]      full day, blocks at Gate A
 *   npx tsx src/pipeline.ts --resume         pick up an approved Gate A and edit
 */

/** Sentinel for "stop cleanly, the reason is already recorded". */
class Stop extends Error {}

const args = process.argv.slice(2);
const RESUME = args.includes("--resume");
const VOICE = args.find((a) => !a.startsWith("--")) ?? "Emma";
const TARGET_DURATION_S = 45;

const slug = new Date().toISOString().slice(0, 10);
const runId = `hn-${slug}`;
const ws = await createWorkspace(runId, slug);

/**
 * Resume exists because the edit phase is the expensive, fragile half — it
 * needs Palmier running, and a crash there should not cost another research
 * pass and another set of TTS calls. The run workspace already holds the
 * approved script and manifest, so resuming reads them off disk rather than
 * regenerating anything.
 */
let state = RESUME ? await loadState(ws) : undefined;
if (RESUME && !state) {
  throw new Error(
    `--resume found no state at ${ws.statePath}. There is nothing to resume; ` +
      `run the pipeline without --resume to start a new day.`,
  );
}
state ??= await initState(ws);

console.log(`run: ${runId}\nworkspace: ${ws.root}\nvoice: ${VOICE}\n`);

let script: ScriptJSON;
let manifest: AssetManifest;
let topicUrl: string;
let hnId: number | undefined;

try {
  if (RESUME) {
    if (!state.script || !state.manifest) {
      throw new Error(
        `--resume: run ${runId} has no script/manifest on its state record. The ` +
          `research phase never finished, so there is nothing approved to edit.`,
      );
    }
    script = state.script;
    manifest = state.manifest;
    topicUrl = script.topic.url;
    hnId = script.topic.hn_id;
    console.log(`resuming with the approved script: ${script.topic.title}`);
  } else {
    await supersedeOlderGates(runId);
    const research = await runResearchPhase({
      runId,
      ws,
      state,
      voice: VOICE,
      targetDurationS: TARGET_DURATION_S,
      onProgress: (m) => console.log(m),
    });
    state = research.state;
    script = research.script;
    manifest = research.manifest;
    topicUrl = research.story.url ?? research.story.hn_url;
    hnId = research.story.id;
  }

  // ── Gate A: a human approves the script before a frame is cut. ────────────
  console.log(`\nwaiting for a human on Gate A…`);
  let lastLog = 0;
  const gateA = await waitForGate(runId, "A_script", {
    onWait: (elapsed) => {
      if (elapsed - lastLog >= 60_000 || lastLog === 0) {
        lastLog = elapsed;
        console.log(`  Gate A still open (${Math.round(elapsed / 60_000)}m)`);
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
    console.error(`\n${why}`);
    process.exitCode = 1;
    throw new Stop();
  }

  console.log(
    `\n=== GATE A APPROVED ===` + (gateA.comment ? `\ncomment: ${gateA.comment}` : ""),
  );
  // An approve-with-comment is a real instruction from a human (PRD §2), and
  // the review loop cannot read it — its directive vocabulary is closed. Rather
  // than silently dropping it, it goes on the record and is shown again at
  // Gate C so the person publishing sees whether their note was addressed.
  if (gateA.comment) {
    await emit(runId, "edit", "log", `Gate A comment carried to Gate C: ${gateA.comment}`);
  }

  // ── Edit + review loop (M1 + M2), against the live Palmier MCP. ───────────
  state = await setPhase(ws, state, "edit");
  const client = new PalmierClient({ requestTimeoutMs: 300_000 });
  await client.connect();

  let outcome;
  try {
    outcome = await runReviewLoop({
      client,
      script,
      manifest,
      workspace: ws,
      onProgress: (m) => console.log(m),
    });
  } finally {
    await client.close();
  }

  console.log(`\n=== REVIEW ${outcome.status.toUpperCase()} ===`);
  for (const it of outcome.iterations) {
    const failed = it.layer1.filter((r) => !r.passed).map((r) => r.name);
    console.log(
      `  #${it.index} mean ${it.meanScore.toFixed(2)}` +
        ` L1 ${it.layer1.length - failed.length}/${it.layer1.length}` +
        (failed.length ? ` FAILED: ${failed.join(",")}` : ""),
    );
  }

  // ── Deliver: the file a human can actually pick up and post. ──────────────
  state = await setPhase(ws, state, "export");
  const delivered = await deliver({
    runId,
    ws,
    script,
    masterPath: outcome.final.masterPath,
    reviewStatus: outcome.status,
    reviewNotes: outcome.status === "escalate" ? outcome.notes : undefined,
    gateAComment: gateA.comment,
    meanScore: outcome.final.meanScore,
    hnId,
    topicUrl,
    onProgress: (m) => console.log(m),
  });

  state = await saveState(ws, {
    ...state,
    iterations: outcome.iterations.length,
    exports: [...outcome.iterations.map((i) => i.masterPath), delivered.outPath],
    // The run is not "done" until a human has published it; publishing is
    // manual for now, so Gate C open IS the end state of an automated run.
    phase: "publish",
  });

  console.log(
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
} catch (err) {
  if (!(err instanceof Stop) && !(err instanceof ResearchEscalation)) {
    const message = err instanceof Error ? err.message : String(err);
    await emit(runId, state.phase, "error", message);
    await saveState(ws, { ...state, phase: "failed", blocked_on: message });
    await notify({ title: `Run ${runId} FAILED`, body: `${state.phase}: ${message}` });
    console.error(`\nFAILED in phase "${state.phase}": ${message}`);
    process.exitCode = 1;
  } else if (err instanceof ResearchEscalation) {
    console.error(`\nESCALATED to Gate A — fact-check failed:\n${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
