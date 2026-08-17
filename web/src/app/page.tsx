import Link from "next/link";
import { listRuns } from "@/lib/data";
import { fmtTokens, fmtDuration, fmtAgo, PHASE_COLOR, GATE_LABEL } from "@/lib/format";
import { StartRun } from "@/components/StartRun";
import { DEFAULT_VOICE } from "@worker/run/execute";

/** The run record changes under us constantly; never serve a cached list. */
export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns();

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">runs</h1>
          <span className="text-dim">{runs.length} total</span>
        </div>
        <StartRun defaultVoice={DEFAULT_VOICE} />
      </div>

      {runs.length === 0 ? (
        <p className="text-muted">
          No runs in <code className="text-fg">kernelshorts.runs</code> yet.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line text-left text-dim">
              <th className="py-1.5 pr-3 font-normal">date</th>
              <th className="py-1.5 pr-3 font-normal">run</th>
              <th className="py-1.5 pr-3 font-normal">topic</th>
              <th className="py-1.5 pr-3 font-normal">phase</th>
              <th className="py-1.5 pr-3 text-right font-normal">iter</th>
              <th className="py-1.5 pr-3 text-right font-normal">exp</th>
              <th className="py-1.5 pr-3 text-right font-normal">tok in</th>
              <th className="py-1.5 pr-3 text-right font-normal">tok out</th>
              <th className="py-1.5 pr-3 text-right font-normal">wall</th>
              <th className="py-1.5 pr-3 font-normal">gate</th>
              <th className="py-1.5 font-normal">updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.run_id}
                className="border-b border-line/60 hover:bg-panel-2/60"
              >
                <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                  <Link href={`/runs/${encodeURIComponent(r.run_id)}`} className="block">
                    {r.date_slug}
                  </Link>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <Link
                    href={`/runs/${encodeURIComponent(r.run_id)}`}
                    className="text-accent hover:underline"
                  >
                    {r.run_id}
                  </Link>
                </td>
                <td className="max-w-[420px] truncate py-1.5 pr-3">
                  <Link href={`/runs/${encodeURIComponent(r.run_id)}`} className="block truncate">
                    {r.topic_title ?? <span className="text-dim">— no script yet —</span>}
                  </Link>
                </td>
                <td className={`py-1.5 pr-3 whitespace-nowrap ${PHASE_COLOR[r.phase] ?? ""}`}>
                  {r.phase}
                  {r.blocked_on ? (
                    <span className="ml-1 text-bad" title={r.blocked_on}>
                      ⚑
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.iterations}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.exports}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                  {fmtTokens(r.inputTokens)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                  {fmtTokens(r.outputTokens)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                  {fmtDuration(r.wallClockMs)}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {r.openGates.length === 0 ? (
                    <span className="text-dim">—</span>
                  ) : (
                    r.openGates.map((g) => (
                      <Link
                        key={g}
                        href="/approvals"
                        title={GATE_LABEL[g] ?? g}
                        className="mr-1 rounded-sm border border-gate/50 bg-gate/10 px-1 text-gate"
                      >
                        {g.replace(/_.*/, "")} open
                      </Link>
                    ))
                  )}
                </td>
                <td className="py-1.5 whitespace-nowrap text-dim">{fmtAgo(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-dim">
        tok in / tok out / wall are the sum of the run record&apos;s per-phase telemetry
        entries (PRD §8). A run whose worker recorded none shows 0 — that is a missing
        measurement, not a free run.
      </p>
    </div>
  );
}
