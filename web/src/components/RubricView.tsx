import { RubricScore, RUBRIC_KEYS } from "@worker/shared/schemas";
import { Absent } from "./Panel";

/** PRD §5: the loop exits only when every dimension is >= 4. */
const PASS = 4;

export interface RubricIteration {
  label: string;
  rubric: RubricScore;
}

/** Parses whatever a `kind: "rubric"` artifact holds. The review loop keeps an
 *  `Iteration` record with more than the rubric on it (export paths, layer-1
 *  results), so accept either the bare RubricScore or a wrapper carrying one. */
export function parseRubric(value: unknown): RubricScore | null {
  const direct = RubricScore.safeParse(value);
  if (direct.success) return direct.data;
  if (value && typeof value === "object" && "rubric" in value) {
    const nested = RubricScore.safeParse((value as { rubric: unknown }).rubric);
    if (nested.success) return nested.data;
  }
  return null;
}

function scoreColor(score: number): string {
  if (score >= PASS) return "text-ok";
  if (score >= 3) return "text-warn";
  return "text-bad";
}

export function RubricView({ iterations }: { iterations: RubricIteration[] }) {
  if (iterations.length === 0) {
    return (
      <Absent what="no rubric artifact in GridFS for this run — the review loop keeps iterations in memory and only persists them when it uploads one" />
    );
  }

  return (
    <div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left text-dim">
            <th className="py-1 pr-2 font-normal">dimension</th>
            {iterations.map((it) => (
              <th key={it.label} className="py-1 pr-2 text-right font-normal">
                {it.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RUBRIC_KEYS.map((key) => (
            <tr key={key} className="border-b border-line/50">
              <td className="py-1 pr-2 text-muted">{key}</td>
              {iterations.map((it) => {
                const cell = it.rubric.scores[key];
                return (
                  <td
                    key={it.label}
                    title={cell.justification}
                    className={`py-1 pr-2 text-right tabular-nums ${scoreColor(cell.score)}`}
                  >
                    {cell.score}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-b border-line">
            <td className="py-1 pr-2 text-dim">mean</td>
            {iterations.map((it) => {
              const mean =
                RUBRIC_KEYS.reduce((a, k) => a + it.rubric.scores[k].score, 0) /
                RUBRIC_KEYS.length;
              return (
                <td
                  key={it.label}
                  className={`py-1 pr-2 text-right tabular-nums ${scoreColor(mean)}`}
                >
                  {mean.toFixed(2)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>

      {iterations.map((it) => (
        <details key={it.label} className="mt-2">
          <summary className="cursor-pointer text-dim hover:text-fg">
            {it.label} — justifications and {it.rubric.fixes.length} fix(es)
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {RUBRIC_KEYS.map((key) => (
              <p key={key}>
                <span className={`mr-2 ${scoreColor(it.rubric.scores[key].score)}`}>
                  {it.rubric.scores[key].score}
                </span>
                <span className="mr-2 text-muted">{key}</span>
                {it.rubric.scores[key].justification}
              </p>
            ))}
            {it.rubric.fixes.map((fix, i) => (
              <p key={i} className="text-warn">
                <span className="mr-2 tabular-nums">{fix.at_s.toFixed(1)}s</span>
                <span className="mr-2 text-dim">{fix.dimension}</span>
                {fix.action}
              </p>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
