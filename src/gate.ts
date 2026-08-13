import { db, COLLECTIONS, closeDb } from "./db/mongo.js";
import { resolveGate, GateName, type Approval } from "./run/gates.js";

/**
 * Answering a gate from a terminal.
 *
 * The dashboard is the real interface — it shows the script, the fact-check
 * table and the VO so a decision is informed. This exists for when the dev
 * server is not up and a run is sitting blocked, which at a daily cadence is
 * most evenings.
 *
 * Deliberately has no "approve everything" mode. A gate exists because a human
 * looked; a flag that answers all of them at once is just an auto-approve with
 * extra steps.
 *
 *   npx tsx src/gate.ts                                    list what is open
 *   npx tsx src/gate.ts approve <runId> [gate] ["comment"]
 *   npx tsx src/gate.ts reject  <runId> [gate] ["reason"]
 *
 * `gate` defaults to the run's single open gate when there is exactly one.
 */

const [action, runId, ...rest] = process.argv.slice(2);

try {
  if (!action || action === "list") {
    const open = await (await db())
      .collection<Approval>(COLLECTIONS.approvals)
      .find({ status: "open" })
      .sort({ opened_at: -1 })
      .toArray();

    if (open.length === 0) {
      console.log("No gates are open — nothing is waiting on you.");
    } else {
      console.log(`${open.length} gate(s) open:\n`);
      for (const a of open) {
        const waitedMin = Math.round((Date.now() - Date.parse(a.opened_at)) / 60_000);
        console.log(`  ${a.run_id}  ${a.gate}  (waiting ${waitedMin}m)`);
        console.log(`    npx tsx src/gate.ts approve ${a.run_id}\n`);
      }
    }
  } else if (action === "approve" || action === "reject") {
    if (!runId) throw new Error(`Usage: npx tsx src/gate.ts ${action} <runId> [gate] ["comment"]`);

    // A gate name is optional when it is unambiguous, but guessing between two
    // open gates would answer the wrong question — so that case asks.
    const openForRun = await (await db())
      .collection<Approval>(COLLECTIONS.approvals)
      .find({ run_id: runId, status: "open" })
      .toArray();

    const named = rest.find((r) => GateName.safeParse(r).success);
    const comment = rest.filter((r) => r !== named).join(" ") || undefined;

    let gate = named ? GateName.parse(named) : undefined;
    if (!gate) {
      if (openForRun.length === 1) gate = openForRun[0]!.gate;
      else if (openForRun.length === 0) {
        throw new Error(`No gate is open for run "${runId}".`);
      } else {
        throw new Error(
          `Run "${runId}" has ${openForRun.length} open gates ` +
            `(${openForRun.map((a) => a.gate).join(", ")}). Name the one you mean.`,
        );
      }
    }

    const resolved = await resolveGate(runId, gate, action === "approve" ? "approved" : "rejected", comment);
    console.log(
      `${resolved.gate} on ${resolved.run_id} → ${resolved.status}` +
        (comment ? `\ncomment: ${comment}` : ""),
    );
    console.log(`\nA waiting pipeline picks this up within ~5s.`);
  } else {
    throw new Error(`Unknown action "${action}". Use: list | approve | reject`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
