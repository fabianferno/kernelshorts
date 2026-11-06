import type { ScriptJSON, VisualSpec } from "@worker/shared/schemas";
import type { GatePayload } from "@/lib/gate-payload";
import { Absent, Field } from "./Panel";


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
  if (visual.type === "generated") {
    return (
      <>
        <span className="text-ok">generated</span> {visual.spec.scene}
        <span className="text-dim"> · {generatedSummary(visual.spec)}</span>
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

/**
 * One line describing what a rendered scene will actually show.
 *
 * The scene NAME alone is useless at the gate — "generated diagram" could be
 * anything, and Gate A is where someone decides whether the visual plan is
 * right. This shows the content the model chose, which is the part worth
 * approving or rejecting.
 */
function generatedSummary(spec: Extract<VisualSpec, { type: "generated" }>["spec"]): string {
  switch (spec.scene) {
    case "code":
      return `${spec.language}, ${spec.code.split("\n").length} lines`;
    case "terminal":
      return spec.lines
        .map((l) => l.command ?? l.output ?? "")
        .filter(Boolean)
        .join(" ; ")
        .slice(0, 90);
    case "diagram":
      return spec.edges
        .map((e) => `${e.from} ${e.direction === "both" ? "↔" : "→"} ${e.to}`)
        .join(", ");
    case "metric":
      return `${spec.value} — ${spec.label}`;
    case "compare":
      return `${spec.left.title} vs ${spec.right.title}`;
    case "particles":
      return spec.mood;
  }
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
