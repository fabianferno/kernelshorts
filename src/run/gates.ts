import { z } from "zod";
import { db, COLLECTIONS } from "../db/mongo.js";
import { emit } from "./workspace.js";
import { notify } from "../notify/push.js";
import { config } from "../config.js";
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
  /**
   * approve-with-comment; becomes an input to the next edit brief (PRD §2).
   *
   * Accepts null as well as absent. An approve with no comment used to write
   * `comment: null` (the Mongo driver serialises undefined that way), and a
   * schema that only allowed `string | undefined` then threw when it read its
   * own write back. That threw inside waitForGate's poll, so approving a gate
   * with no comment KILLED the run that was waiting for the approval.
   * Normalised to undefined so nothing downstream has to know about null.
   */
  comment: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
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
  // Best-effort: a push failure must not fail the gate. The gate is already
  // durable in Mongo at this point, so the worst case is a human who has to
  // look at the dashboard themselves.
  await notify({
    title: `Gate ${gate} needs you`,
    body: `Run ${runId} is blocked awaiting approval.`,
    url: config.dashboardUrl ? `${config.dashboardUrl}/runs/${runId}` : undefined,
  }).catch((err) => console.warn(`[gates] notify failed: ${err}`));
  return record;
}

export type GateOutcome = "approved" | "rejected" | "superseded";

export class GateTimeoutError extends Error {
  constructor(
    readonly runId: string,
    readonly gate: GateName,
    readonly waitedMs: number,
  ) {
    super(
      `Gate ${gate} on run ${runId} was still open after ${Math.round(waitedMs / 3600_000)}h. ` +
        `No decision was made — nothing is approved.`,
    );
    this.name = "GateTimeoutError";
  }
}

/**
 * Blocks the run until a human resolves the gate (PRD §2: "a run blocks on an
 * open gate").
 *
 * Polling, not a change stream: the worker already reconnects to Atlas lazily
 * and a 5 s poll on one small document is free next to what the pipeline costs.
 * It also survives a laptop sleeping mid-wait, which a change stream does not.
 *
 * Timeout is 24 h. The human is asleep, so anything under ~12 h is a false
 * alarm; the reason it is finite at all is that the next day's run supersedes
 * this gate anyway — a wait longer than the daily cadence can only mean the
 * process is wedged. On timeout this THROWS. It never approves: a gate that
 * expired is a question nobody answered, not a yes.
 */
export async function waitForGate(
  runId: string,
  gate: GateName,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Called on each poll while still open, for a progress line. */
    onWait?: (elapsedMs: number) => void;
  } = {},
): Promise<Approval & { status: GateOutcome }> {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
  const started = Date.now();

  for (;;) {
    const current = await getGate(runId, gate);
    if (!current) throw new Error(`No ${gate} gate exists for run ${runId}`);
    if (current.status !== "open") {
      // Superseded is a real outcome the caller must distinguish from approved:
      // it means the run was overtaken, not blessed.
      return current as Approval & { status: GateOutcome };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) throw new GateTimeoutError(runId, gate, elapsed);
    opts.onWait?.(elapsed);
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, timeoutMs - elapsed)));
  }
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
  // Only $set comment when there IS one. Passing undefined here is what wrote
  // the null in the first place; the read path tolerates it now, but writing a
  // field to mean "no field" is worth not doing.
  const update: Record<string, unknown> = { status, resolved_at: new Date().toISOString() };
  if (comment !== undefined && comment !== null) update.comment = comment;

  const updated = await approvals.findOneAndUpdate(
    { run_id: runId, gate },
    { $set: update },
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
 * Gates that a newer run invalidates.
 *
 * NOT C_publish, and the distinction matters. A and B block an unfinished run:
 * yesterday's unapproved script is stale the moment today's topic is picked,
 * and yesterday's escalated edit is not worth a human's time once a new one
 * exists. But C_publish sits on a FINISHED, playable video — publishing it is
 * still a perfectly good thing to do tomorrow, and expiring it would quietly
 * throw away a day's work that already cost real money to produce.
 *
 * Caught before it happened: yesterday's WebSockets short was sitting at
 * Gate C when the next run was about to start, and the original blanket
 * updateMany would have marked it superseded.
 */
const SUPERSEDABLE: GateName[] = ["A_script", "B_review_escalation"];

/**
 * Expires stale gates on older runs (PRD §2: "a run is auto-expired when
 * superseded by the next day's run"). Superseded is its own status, never
 * approved — an unanswered gate is a question that expired, not a yes.
 */
export async function supersedeOlderGates(currentRunId: string): Promise<number> {
  const res = await (await db())
    .collection<Approval>(COLLECTIONS.approvals)
    .updateMany(
      { status: "open", run_id: { $ne: currentRunId }, gate: { $in: SUPERSEDABLE } },
      { $set: { status: "superseded", resolved_at: new Date().toISOString() } },
    );
  return res.modifiedCount;
}
