import { join } from "node:path";
import { runResearchPhase, ResearchEscalation } from "./phases/research.js";
import { createWorkspace, initState, saveState, emit } from "./run/workspace.js";
import { waitForGate, supersedeOlderGates } from "./run/gates.js";
import { notify } from "./notify/push.js";
import { closeDb } from "./db/mongo.js";

/**
 * M3 (PRD §7): the research phase on its own — a real HN topic, researched
 * from real pages, fact-checked against them, scripted, voiced, staged for
 * Gate A, and then it stops.
 *
 * The phase itself lives in src/phases/research.ts and is shared with
 * src/pipeline.ts, which carries straight on into the edit after the gate.
 * Keep this driver for working on the research phase alone without spending an
 * edit build and a review loop on every iteration.
 *
 * Run: npx tsx src/m3.ts [voiceName] [--no-wait]
 *
 * By default this BLOCKS at Gate A until a human answers (PRD §2).
 * `--no-wait` opens the gate and exits 0 so the run can be kicked off
 * unattended and answered later — it is not an auto-approve.
 */

const args = process.argv.slice(2);
const NO_WAIT = args.includes("--no-wait");
const VOICE = args.find((a) => !a.startsWith("--")) ?? "Fabian";
const TARGET_DURATION_S = 45;

const slug = new Date().toISOString().slice(0, 10);
const runId = `hn-${slug}`;
const ws = await createWorkspace(runId, slug);
let state = await initState(ws);

console.log(`run: ${runId}\nworkspace: ${ws.root}\nvoice: ${VOICE}\n`);

try {
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

  console.log(
    `\n=== GATE A OPEN ===\n` +
      `script:    ${join(ws.root, "script.json")}\n` +
      `brief:     ${join(ws.root, "brief.json")}\n` +
      `factcheck: ${join(ws.root, "factcheck.json")}\n` +
      `voiceover: ${ws.vo}\n\n` +
      `The run stops here until a human approves. Nothing auto-approves.`,
  );

  if (NO_WAIT) {
    console.log(`\n--no-wait: leaving Gate A open. Answer it in the dashboard.`);
  } else {
    console.log(`\nwaiting for a human on Gate A…`);
    let lastLog = 0;
    const decision = await waitForGate(runId, "A_script", {
      onWait: (elapsed) => {
        // One line a minute: enough to prove it is alive in a terminal that
        // may be watched for hours, few enough to scroll back through.
        if (elapsed - lastLog >= 60_000 || lastLog === 0) {
          lastLog = elapsed;
          console.log(`  still open (${Math.round(elapsed / 1000)}s)`);
        }
      },
    });

    state = await saveState(ws, {
      ...state,
      gate_a: {
        status: decision.status,
        comment: decision.comment,
        resolved_at: decision.resolved_at,
      },
    });

    if (decision.status === "approved") {
      console.log(
        `\n=== GATE A APPROVED ===` +
          (decision.comment ? `\ncomment: ${decision.comment}` : `\n(no comment)`) +
          `\nresolved_at: ${decision.resolved_at}\n\n` +
          `Continue into the edit with: npx tsx src/pipeline.ts --resume`,
      );
    } else {
      // Rejected and superseded are both "do not proceed", but they are not
      // the same event and the run record must not conflate them.
      const why =
        decision.status === "rejected"
          ? `Gate A rejected${decision.comment ? `: ${decision.comment}` : ""}`
          : `Gate A superseded by a newer run — this run was overtaken, not approved`;
      await emit(runId, "script", "gate_closed", why);
      await notify({ title: `Run ${runId} stopped`, body: why });
      await saveState(ws, { ...state, phase: "failed", blocked_on: why });
      console.error(`\n${why}`);
      process.exitCode = 1;
    }
  }
} catch (err) {
  if (err instanceof ResearchEscalation) {
    // Gate A is already open with the failing lines attached; the run record is
    // already marked failed. Nothing to add but the exit code.
    console.error(`\nESCALATED to Gate A — fact-check failed:\n${err.message}`);
    process.exitCode = 1;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    await emit(runId, state.phase, "error", message);
    await saveState(ws, { ...state, phase: "failed", blocked_on: message });
    await notify({ title: `Run ${runId} FAILED`, body: `${state.phase}: ${message}` });
    console.error(`\nFAILED in phase "${state.phase}": ${message}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
