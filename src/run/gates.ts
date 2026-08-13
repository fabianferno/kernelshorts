import { z } from "zod";
import { db, COLLECTIONS } from "../db/mongo.js";
import { emit } from "./workspace.js";
import type { RunPhase } from "../shared/schemas.js";

/**
 * Human gates (PRD §2).
 *
 * A gate is a real blocking record, not a pause the pipeline can talk itself
 * past. Opening one writes an `approvals` document with status "open" and the
 * run stops; only a human action (the web app in M4, or `resolveGate` called
 * directly until then) moves it to approved/rejected. There is deliberately no
 * auto-approve, no timeout-to-approved, and no "assume yes in unattended mode":
 * every one of those is a way to publish something nobody looked at.
 *
 * Supersession is the one automatic transition, and it only ever CLOSES a gate
 * without approving it — yesterday's unanswered script should not go out today.
 */

export const GateName = z.enum(["A_script", "B_review_escalation", "C_publish"]);
export type GateName = z.infer<typeof GateName>;

export const Approval = z.object({
  run_id: z.string(),
  gate: GateName,
  status: z.enum(["open", "approved", "rejected", "superseded"]),
  /** What the dashboard shows: artifact paths, the script, reviewer notes. */
  payload: z.unknown(),
  /** approve-with-comment; becomes an input to the next edit brief (PRD §2). */
  comment: z.string().optional(),
  opened_at: z.string(),
  resolved_at: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;

const PHASE_OF_GATE: Record<GateName, RunPhase> = {
  A_script: "script",
  B_review_escalation: "review",
  C_publish: "publish",
};

export async function openGate(
  runId: string,
  gate: GateName,
  payload: unknown,
): Promise<Approval> {
  const approvals = (await db()).collection<Approval>(COLLECTIONS.approvals);
  await approvals.createIndex({ run_id: 1, gate: 1 }, { unique: true });

  const record = Approval.parse({
    run_id: runId,
    gate,
    status: "open",
    payload,
    opened_at: new Date().toISOString(),
  });
  await approvals.replaceOne({ run_id: runId, gate }, record, { upsert: true });
  await emit(runId, PHASE_OF_GATE[gate], "gate_open", `gate ${gate} open — awaiting a human`);
  return record;
}

export async function getGate(runId: string, gate: GateName): Promise<Approval | undefined> {
  const found = await (await db())
    .collection<Approval>(COLLECTIONS.approvals)
    .findOne({ run_id: runId, gate });
  return found ? Approval.parse(found) : undefined;
}

export async function resolveGate(
  runId: string,
  gate: GateName,
  status: "approved" | "rejected",
  comment?: string,
): Promise<Approval> {
  const approvals = (await db()).collection<Approval>(COLLECTIONS.approvals);
  const updated = await approvals.findOneAndUpdate(
    { run_id: runId, gate },
    { $set: { status, comment, resolved_at: new Date().toISOString() } },
    { returnDocument: "after" },
  );
  if (!updated) throw new Error(`No ${gate} gate is open for run ${runId}`);
  await emit(
    runId,
    PHASE_OF_GATE[gate],
    "gate_closed",
    `gate ${gate} ${status}${comment ? `: ${comment}` : ""}`,
  );
  return Approval.parse(updated);
}

/**
 * Expires every gate still open on an older run (PRD §2: "a run is auto-expired
 * when superseded by the next day's run"). Superseded is its own status, never
 * approved — an unanswered gate is a question that expired, not a yes.
 */
export async function supersedeOlderGates(currentRunId: string): Promise<number> {
  const res = await (await db())
    .collection<Approval>(COLLECTIONS.approvals)
    .updateMany(
      { status: "open", run_id: { $ne: currentRunId } },
      { $set: { status: "superseded", resolved_at: new Date().toISOString() } },
    );
  return res.modifiedCount;
}
