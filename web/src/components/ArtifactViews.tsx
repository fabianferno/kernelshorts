import type { ScriptJSON } from "@worker/shared/schemas";
import type { ResearchBrief } from "@worker/research/brief";
import type { FactCheckReport } from "@worker/research/factcheck";
import type { GatePayload } from "@/lib/gate-payload";
import { Absent, Field } from "./Panel";

export function Shortlist({ shortlist }: { shortlist: GatePayload["shortlist"] }) {
  if (!shortlist || shortlist.length === 0) {
    return <Absent what="no ranked shortlist on this gate's payload" />;
  }
  return (
    <ol className="flex flex-col gap-2">
      {shortlist.map((item, i) => (
        <li key={`${item.title}-${i}`} className="rounded border border-line bg-panel-2 p-2">
          <div className="flex items-baseline gap-2">
            <span className="text-dim">#{i + 1}</span>
            <span className={i === 0 ? "font-semibold text-ok" : ""}>{item.title}</span>
            <span className="ml-auto shrink-0 tabular-nums text-warn">
              {item.score.toFixed(2)}
            </span>
          </div>
          <p className="mt-1 text-muted">{item.justification}</p>
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate text-accent hover:underline"
            >
              {item.url}
            </a>
          ) : null}
        </li>
      ))}
      <li className="text-dim">
        #1 is the pick; the rest are the runners-up the ranker scored (PRD §3.3).
      </li>
    </ol>
  );
}

export function BriefView({ brief }: { brief?: ResearchBrief }) {
  if (!brief) return <Absent what="no research brief on this gate's payload" />;
  return (
    <div>
      <Field label="topic">{brief.topic}</Field>
      <Field label="summary">
        <span className="text-muted">{brief.summary}</span>
      </Field>
      <Field label="what it is">
        <span className="text-muted">{brief.what_it_is}</span>
      </Field>
      <Field label="why it matters">
        <span className="text-muted">{brief.why_it_matters}</span>
      </Field>
      <Field label="how it works">
        <span className="text-muted">{brief.how_it_works}</span>
      </Field>
      <Field label="skeptic take">
        <span className="text-warn">{brief.skeptic_take}</span>
      </Field>
      {brief.notable_numbers.length > 0 ? (
        <Field label="notable numbers">
          <ul className="flex flex-wrap gap-1">
            {brief.notable_numbers.map((n) => (
              <li key={n} className="rounded border border-line-2 bg-panel-2 px-1.5">
                {n}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      <Field label="demo surface">
        <a
          href={brief.demo_surface.url}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          {brief.demo_surface.url}
        </a>
        <p className="text-muted">{brief.demo_surface.what_to_show}</p>
      </Field>
    </div>
  );
}

function visualLine(visual: ScriptJSON["beats"][number]["visual"]): React.ReactNode {
  if (visual.type === "screenrec") {
    return (
      <>
        <span className="text-accent">screenrec</span> {visual.viewport}{" "}
        <a href={visual.url} target="_blank" rel="noreferrer" className="hover:underline">
          {visual.url}
        </a>
        {visual.actions.length > 0 ? (
          <span className="text-dim"> · {visual.actions.join(" → ")}</span>
        ) : null}
      </>
    );
  }
  if (visual.type === "stock") {
    return (
      <>
        <span className="text-warn">stock</span> “{visual.query}”
        {visual.preferVault ? <span className="text-dim"> · vault first</span> : null}
      </>
    );
  }
  return (
    <>
      <span className="text-gate">still</span> {visual.source}
      {visual.kenBurns ? <span className="text-dim"> · ken burns</span> : null}
    </>
  );
}

export function ScriptView({
  script,
  voiceover,
  assets,
}: {
  script?: ScriptJSON;
  voiceover?: GatePayload["voiceover"];
  assets?: GatePayload["assets"];
}) {
  if (!script) return <Absent what="the run record has no script yet" />;

  const voById = new Map((voiceover ?? []).map((v) => [v.beat_id, v]));
  const assetById = new Map((assets ?? []).map((a) => [a.beat_id, a]));

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-dim">
        <span>
          target <span className="text-fg">{script.target_duration_s}s</span>
        </span>
        <span>
          music <span className="text-fg">{script.music_mood}</span>
        </span>
        <span>
          beats <span className="text-fg">{script.beats.length}</span>
        </span>
        <span>
          claims <span className="text-fg">{script.claims.length}</span>
        </span>
        {script.topic.hn_id ? (
          <a
            href={`https://news.ycombinator.com/item?id=${script.topic.hn_id}`}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            HN {script.topic.hn_id}
          </a>
        ) : null}
      </div>

      <ol className="flex flex-col gap-2">
        {script.beats.map((beat, i) => {
          const vo = voById.get(beat.id);
          const asset = assetById.get(beat.id);
          return (
            <li key={beat.id} className="rounded border border-line bg-panel-2 p-2">
              <div className="flex items-baseline gap-2 text-dim">
                <span className="tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                <span className="font-semibold text-fg">{beat.id}</span>
                <span className="ml-auto tabular-nums">
                  {vo ? (
                    <span className="text-ok">{vo.durationS.toFixed(2)}s measured</span>
                  ) : (
                    <span>≤{beat.max_duration_s}s planned</span>
                  )}
                </span>
              </div>

              <p className="mt-1">
                <span className="mr-1 text-dim">vo</span>
                {beat.vo_text}
              </p>

              {beat.on_screen_text ? (
                <p className="mt-1">
                  <span className="mr-1 text-dim">text</span>
                  <span className="rounded bg-fg/10 px-1 font-semibold">
                    {beat.on_screen_text}
                  </span>
                </p>
              ) : null}

              {beat.on_screen_image ? (
                <p className="mt-1 text-muted">
                  <span className="mr-1 text-dim">image</span>
                  {beat.on_screen_image.source}
                  <span className="text-dim">
                    {" "}
                    · scale {beat.on_screen_image.scale} · centerY{" "}
                    {beat.on_screen_image.centerY}
                  </span>
                </p>
              ) : null}

              <p className="mt-1 text-muted">
                <span className="mr-1 text-dim">visual</span>
                {visualLine(beat.visual)}
              </p>

              {asset ? (
                <p className="mt-1 text-dim">
                  <span className="mr-1">acquired</span>
                  <span className="text-ok">{asset.kind}</span> {asset.path}
                </p>
              ) : null}
            </li>
          );
        })}

        <li className="rounded border border-gate/40 bg-gate/5 p-2">
          <div className="text-dim">cta</div>
          <p>
            <span className="mr-1 text-dim">vo</span>
            {script.cta.vo_text}
          </p>
          <p>
            <span className="mr-1 text-dim">text</span>
            <span className="rounded bg-fg/10 px-1 font-semibold">
              {script.cta.on_screen_text}
            </span>
          </p>
        </li>
      </ol>
    </div>
  );
}

const LINE_STATUS: Record<string, { color: string; label: string }> = {
  sourced: { color: "text-ok", label: "sourced" },
  not_factual: { color: "text-dim", label: "not a claim" },
  unsourced: { color: "text-bad", label: "UNSOURCED" },
};

export function FactCheckView({ report }: { report?: FactCheckReport }) {
  if (!report) return <Absent what="no fact-check report on this gate's payload" />;

  const unsourced = report.lines.filter((l) => l.status === "unsourced").length;

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 text-dim">
        <span className={report.passed ? "text-ok" : "text-bad"}>
          {report.passed ? "PASSED" : "FAILED"}
        </span>
        <span>
          {report.lines.length} VO lines · {report.claims.length} claims ·{" "}
          <span className={unsourced ? "text-bad" : "text-ok"}>{unsourced} unsourced</span>
        </span>
      </div>

      {report.problems.length > 0 ? (
        <ul className="mb-2 rounded border border-bad/40 bg-bad/5 p-2">
          {report.problems.map((p, i) => (
            <li key={i} className="text-bad">
              {p}
            </li>
          ))}
        </ul>
      ) : null}

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left text-dim">
            <th className="py-1 pr-2 font-normal">beat</th>
            <th className="py-1 pr-2 font-normal">status</th>
            <th className="py-1 pr-2 font-normal">vo line</th>
            <th className="py-1 font-normal">source</th>
          </tr>
        </thead>
        <tbody>
          {report.lines.map((line, i) => {
            const status = LINE_STATUS[line.status] ?? { color: "", label: line.status };
            return (
              <tr key={`${line.beat_id}-${i}`} className="border-b border-line/50 align-top">
                <td className="py-1 pr-2 whitespace-nowrap text-muted">{line.beat_id}</td>
                <td className={`py-1 pr-2 whitespace-nowrap ${status.color}`}>{status.label}</td>
                <td className="py-1 pr-2">
                  {line.vo_text}
                  <div className="text-dim">{line.note}</div>
                </td>
                <td className="max-w-[220px] py-1">
                  {line.source_url ? (
                    <a
                      href={line.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-accent hover:underline"
                      title={line.source_url}
                    >
                      {line.source_url}
                    </a>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {report.claims.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-dim hover:text-fg">
            claim → source grounding ({report.claims.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {report.claims.map((claim, i) => (
              <li key={i} className="rounded border border-line bg-panel-2 p-2">
                <div className={claim.grounded ? "text-ok" : "text-bad"}>
                  {claim.grounded ? "grounded" : "NOT GROUNDED"}
                  <span className="ml-2 text-dim">{claim.detail}</span>
                </div>
                <p>{claim.text}</p>
                <p className="mt-1 border-l-2 border-line-2 pl-2 text-muted italic">
                  “{claim.excerpt}”
                </p>
                <a
                  href={claim.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-accent hover:underline"
                >
                  {claim.source_url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
