import Link from "next/link";
import { listOpenApprovals } from "@/lib/data";
import { parseGatePayload } from "@/lib/gate-payload";
import { GateActions } from "@/components/GateActions";
import { ScriptView } from "@/components/ArtifactViews";
import { fmtAgo, GATE_LABEL } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The inbox: every gate with status "open", newest first. Each one is a run
 * that is stopped dead until someone answers it, so the actions are inline —
 * the common case is approving a script you have already read, and making that
 * a two-page trip is how a run sits blocked overnight.
 */
export default async function ApprovalsPage() {
  const approvals = await listOpenApprovals();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-base font-semibold">approval inbox</h1>
        <span className="text-dim">
          {approvals.length} open · {approvals.length === 1 ? "1 run is" : `${approvals.length} runs are`}{" "}
          blocked
        </span>
      </div>

      {approvals.length === 0 ? (
        <p className="text-muted">
          Nothing open. Every gate in <code className="text-fg">kernelshorts.approvals</code> is
          resolved or superseded.
        </p>
      ) : null}

      {approvals.map((approval) => {
        const payload = parseGatePayload(approval.payload);
        return (
          <article
            key={`${approval.run_id}-${approval.gate}`}
            className="rounded border border-gate/50 bg-panel"
          >
            <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-3 py-2">
              <span className="font-semibold text-gate">
                {GATE_LABEL[approval.gate] ?? approval.gate}
              </span>
              <Link
                href={`/runs/${encodeURIComponent(approval.run_id)}`}
                className="text-accent hover:underline"
              >
                {approval.run_id}
              </Link>
              {payload?.script ? (
                <span className="text-muted">{payload.script.topic.title}</span>
              ) : null}
              <span className="ml-auto text-dim" title={approval.opened_at}>
                opened {fmtAgo(approval.opened_at)}
              </span>
            </header>

            <div className="border-b border-line px-3 py-2">
              <GateActions runId={approval.run_id} gate={approval.gate} />
            </div>

            {payload?.outcome === "escalated" ? (
              <div className="mx-3 mt-3 rounded border border-bad/50 bg-bad/10 p-2 text-bad">
                escalated: {payload.reason ?? "no reason recorded"}
                {payload.problems?.length ? (
                  <ul className="mt-1 text-muted">
                    {payload.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {payload?.durationWarning ? (
              <div className="mx-3 mt-3 rounded border border-warn/50 bg-warn/10 p-2 text-warn">
                {payload.durationWarning}
              </div>
            ) : null}

            {payload === null ? (
              <pre className="m-3 max-h-96 overflow-auto rounded border border-line bg-ink p-2 text-muted">
                {/* The payload did not match any shape this app knows. Showing the
                    raw document beats showing nothing on a gate blocking a run. */}
                {JSON.stringify(approval.payload, null, 2)}
              </pre>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2">
                <section className="xl:col-span-2">
                  <h3 className="mb-1 text-[11px] uppercase tracking-widest text-muted">
                    script
                    {payload.voTotalS !== undefined ? (
                      <span className="ml-2 normal-case text-dim">
                        VO total {payload.voTotalS.toFixed(1)}s
                      </span>
                    ) : null}
                  </h3>
                  <ScriptView
                    script={payload.script}
                    voiceover={payload.voiceover}
                    assets={payload.assets}
                  />
                </section>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
