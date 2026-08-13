import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveGate, GateName } from "@worker/run/gates";

export const dynamic = "force-dynamic";

/**
 * The single write path for a human decision on a gate.
 *
 * It calls the worker's `resolveGate` rather than issuing its own update. The
 * status transitions and the `gate_closed` event that unblocks the run are one
 * implementation on purpose — a dashboard that wrote `{status: "approved"}`
 * directly would approve a gate without ever emitting the event the run is
 * waiting on, and the run would sit blocked while the UI showed it resolved.
 *
 * "approve-with-comment" is not a third status (PRD §2): it is `approved` with
 * a comment persisted on the approval document, where the next edit brief reads
 * it. Rejection carries a comment too — a rejection with no stated reason is
 * unactionable for whoever rewrites the script.
 */
const Body = z.object({
  run_id: z.string().min(1),
  gate: GateName,
  status: z.enum(["approved", "rejected"]),
  comment: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { run_id, gate, status, comment } = parsed.data;
  try {
    const approval = await resolveGate(run_id, gate, status, comment);
    // The payload is the whole artifact bundle the gate was opened with — tens
    // of KB of script and fact-check. The caller is re-rendering a row, not
    // re-reading the brief.
    const { payload: _payload, ...summary } = approval;
    return NextResponse.json({ approval: summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `resolveGate` throws exactly one way: no such gate for that run.
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
