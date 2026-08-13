"use client";

import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@worker/shared/schemas";
import { fmtClock, KIND_COLOR, PHASE_COLOR } from "@/lib/format";

const POLL_MS = 3000;

/**
 * The live feed. Seeded with the server-rendered events so the page is complete
 * on first paint, then tailed incrementally by `?since=`.
 *
 * `since` is the ts of the last event we hold rather than a wall-clock "now":
 * the worker's clock and this browser's clock are not the same clock, and a
 * "now"-based cursor drops any event written during the skew.
 */
export function EventFeed({
  runId,
  initialEvents,
  initialPhase,
}: {
  runId: string;
  initialEvents: RunEvent[];
  initialPhase: string;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [phase, setPhase] = useState(initialPhase);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  const cursor = useRef(initialEvents.at(-1)?.ts);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    async function tick() {
      try {
        const url = `/api/runs/${encodeURIComponent(runId)}/events${
          cursor.current ? `?since=${encodeURIComponent(cursor.current)}` : ""
        }`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { events: RunEvent[]; phase: string };
        if (cancelled) return;
        setError(null);
        setPhase(body.phase);
        if (body.events.length > 0) {
          cursor.current = body.events.at(-1)!.ts;
          setEvents((previous) => [...previous, ...body.events]);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId, live]);

  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events, follow]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-dim">
        <span>
          <span className={`mr-1 ${PHASE_COLOR[phase] ?? ""}`}>●</span>
          phase <span className={PHASE_COLOR[phase] ?? "text-fg"}>{phase}</span>
        </span>
        <span>{events.length} events</span>
        <label className="flex cursor-pointer items-center gap-1 select-none">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          live ({POLL_MS / 1000}s poll)
        </label>
        <label className="flex cursor-pointer items-center gap-1 select-none">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          follow tail
        </label>
        {error ? <span className="text-bad">poll failed: {error}</span> : null}
      </div>

      <div
        ref={scroller}
        onWheel={() => setFollow(false)}
        className="max-h-[520px] overflow-y-auto rounded border border-line bg-ink"
      >
        {events.length === 0 ? (
          <p className="p-3 text-dim italic">no events in run_events for this run</p>
        ) : (
          groupByPhase(events).map((group, index) => (
            <div key={`${group.phase}-${index}`}>
              <div className="sticky top-0 z-10 border-y border-line bg-panel-2/95 px-2 py-1 backdrop-blur">
                <span className={PHASE_COLOR[group.phase] ?? ""}>{group.phase}</span>
                <span className="ml-2 text-dim">
                  {group.events.length} · {fmtClock(group.events[0]!.ts)}–
                  {fmtClock(group.events.at(-1)!.ts)}
                </span>
              </div>
              {group.events.map((event, i) => (
                <EventRow key={`${event.ts}-${i}`} event={event} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const hasData = event.data !== undefined && event.data !== null;
  return (
    <div
      className={`border-b border-line/40 px-2 py-1 last:border-0 ${
        event.kind === "error" ? "bg-bad/5" : ""
      } ${event.kind.startsWith("gate") ? "bg-gate/5" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-dim tabular-nums">{fmtClock(event.ts)}</span>
        <span className={`w-[72px] shrink-0 ${KIND_COLOR[event.kind] ?? ""}`}>{event.kind}</span>
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{event.message}</span>
        {hasData ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-dim hover:text-accent"
          >
            {open ? "hide data" : "data"}
          </button>
        ) : null}
      </div>
      {open && hasData ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-panel p-2 text-[11px] text-muted">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/** Consecutive runs of the same phase, in order — the run re-enters `edit`
 *  after every review iteration, so grouping by distinct phase name would
 *  collapse twelve separate edit passes into one heading. */
function groupByPhase(events: RunEvent[]): { phase: string; events: RunEvent[] }[] {
  const groups: { phase: string; events: RunEvent[] }[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last.phase === event.phase) last.events.push(event);
    else groups.push({ phase: event.phase, events: [event] });
  }
  return groups;
}
