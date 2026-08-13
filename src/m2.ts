import { readFileSync } from "node:fs";
import { RunState } from "./shared/schemas.js";
import { PalmierClient } from "./palmier/client.js";
import { runReviewLoop } from "./review/loop.js";
import { createWorkspace, saveState, emit } from "./run/workspace.js";
import { closeDb } from "./db/mongo.js";
import { openGate } from "./run/gates.js";
import { putArtifact } from "./run/artifacts.js";
import { RUBRIC_KEYS } from "./shared/schemas.js";

/**
 * M2 (PRD §7): the review loop, run against the REAL M1 output — a real
 * exported file, not a sample video.
 *
 * Run: npx tsx src/m2.ts [stateJsonPath]
 */

const statePath = process.argv[2] ?? `${process.env.HOME}/pipeline/runs/2026-08-12/state.json`;
const state = RunState.parse(JSON.parse(readFileSync(statePath, "utf8")));
if (!state.script || !state.manifest) throw new Error(`${statePath} has no script/manifest`);

const ws = await createWorkspace(state.run_id, state.date_slug);
const client = new PalmierClient({ requestTimeoutMs: 300_000 });
await client.connect();

try {
  const outcome = await runReviewLoop({
    client,
    script: state.script,
    manifest: state.manifest,
    workspace: ws,
    onProgress: (m) => console.log(m),
  });

  console.log(`\n=== ${outcome.status.toUpperCase()} ===`);
  if (outcome.status === "escalate") {
    console.log(`reason: ${outcome.reason}`);
    console.log(`notes:  ${outcome.notes}`);
  }

  console.log(`\niterations: ${outcome.iterations.length}`);
  for (const it of outcome.iterations) {
    const failed = it.layer1.filter((r) => !r.passed).map((r) => r.name);
    console.log(
      `  #${it.index} mean ${it.meanScore.toFixed(2)} ` +
        `[${RUBRIC_KEYS.map((k) => it.rubric.scores[k].score).join(",")}] ` +
        `L1 ${it.layer1.length - failed.length}/${it.layer1.length} ` +
        `tokens ${it.inputTokens}/${it.outputTokens} ` +
        `${(it.wallClockMs / 1000).toFixed(0)}s` +
        (failed.length ? ` FAILED: ${failed.join(",")}` : ""),
    );
    if (it.directives) {
      for (const d of it.directives.directives) console.log(`      → ${d.kind}: ${d.reason}`);
      for (const u of it.directives.unaddressable) console.log(`      ✗ ${u.at_s}s ${u.action}`);
    }
  }

  const totalIn = outcome.iterations.reduce((s, i) => s + i.inputTokens, 0);
  const totalOut = outcome.iterations.reduce((s, i) => s + i.outputTokens, 0);
  const totalMs = outcome.iterations.reduce((s, i) => s + i.wallClockMs, 0);
  console.log(`\ntotal: ${totalIn} in / ${totalOut} out tokens, ${(totalMs / 1000).toFixed(0)}s`);
  console.log(`final master: ${outcome.final.masterPath}`);

  await saveState(ws, {
    ...state,
    phase: outcome.status === "passed" ? "done" : "review",
    iterations: outcome.iterations.length,
    exports: outcome.iterations.map((i) => i.masterPath),
    blocked_on: outcome.status === "escalate" ? `Gate B: ${outcome.reason}` : undefined,
  });
  // The finished video goes to GridFS either way: on a pass it is what Gate C
  // will show, and on an escalation it is the thing the human at Gate B has to
  // watch. A path on the worker's disk is not something a dashboard can play.
  await putArtifact(state.run_id, outcome.final.masterPath, {
    kind: "export",
    phase: "review",
    label: `final master — mean ${outcome.final.meanScore.toFixed(2)}`,
  });

  if (outcome.status === "passed") {
    await emit(state.run_id, "review", "log", "review loop passed");
  } else {
    // Gate B (PRD §5): conditional escalation, with the video and the
    // reviewer's notes. Previously the loop just emitted a gate_open EVENT and
    // stopped — which looked like a gate in the feed but created no approval
    // record, so nothing was actually waiting for anyone and the dashboard
    // inbox stayed empty.
    await openGate(state.run_id, "B_review_escalation", {
      reason: outcome.reason,
      notes: outcome.notes,
      finalMeanScore: outcome.final.meanScore,
      masterPath: outcome.final.masterPath,
      iterations: outcome.iterations.map((it) => ({
        index: it.index,
        meanScore: it.meanScore,
        scores: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, it.rubric.scores[k].score])),
        failedVerifiers: it.layer1.filter((r) => !r.passed).map((r) => r.name),
        unaddressable: it.directives?.unaddressable ?? [],
      })),
    });
  }
} finally {
  await client.close();
  await closeDb();
}
