"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const PLATFORMS = [
  { id: "youtube_shorts", label: "YouTube Shorts" },
  { id: "instagram_reels", label: "Instagram Reels" },
] as const;

type Platform = (typeof PLATFORMS)[number]["id"];

export interface PublishedState {
  platforms: string[];
  url: string;
  title: string;
  notes?: string;
  published_at: string;
}

/**
 * The "I posted it" form.
 *
 * Nothing here is pre-ticked. The two platforms are separate uploads done by
 * hand and it is entirely normal to do one and not the other; a default of
 * "both" would be the dashboard asserting something the human never did, and
 * that assertion is what the publish record is FOR.
 *
 * The url is editable because it is the dedupe key: it is what stops tomorrow's
 * run remaking this story, so on the rare occasion the script recorded a
 * redirect or a tracking-param url, the operator has to be able to fix it here.
 */
export function MarkPublished({
  runId,
  topicUrl,
  topicTitle,
  hnId,
  published,
}: {
  runId: string;
  topicUrl: string;
  topicTitle: string;
  hnId?: number;
  published: PublishedState | null;
}) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [url, setUrl] = useState(topicUrl);
  const [title, setTitle] = useState(topicTitle);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/publish/mark", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          url: url.trim(),
          title: title.trim(),
          platforms,
          hn_id: hnId,
          notes: notes.trim() === "" ? undefined : notes.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      // The gate close is best-effort on the server; say which happened rather
      // than showing a green tick over a gate that is still open.
      setResult(`recorded — gate C: ${body.gate}`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || pending;

  if (published) {
    return (
      <div className="rounded border border-ok/40 bg-ok/5 p-2">
        <div className="text-ok">
          published {published.published_at} → {published.platforms.join(", ")}
        </div>
        <div className="mt-1 text-muted">
          topic recorded in published_topics as <span className="text-fg">{published.url}</span> —
          tomorrow&apos;s HN ingest will skip it
        </div>
        {published.notes ? <div className="mt-1 text-muted">{published.notes}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-dim">posted to:</span>
        {PLATFORMS.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              type="checkbox"
              checked={platforms.includes(p.id)}
              onChange={(e) =>
                setPlatforms((cur) =>
                  e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id),
                )
              }
              disabled={busy}
              className="accent-accent"
            />
            <span className={platforms.includes(p.id) ? "text-fg" : "text-muted"}>{p.label}</span>
          </label>
        ))}
      </div>

      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wider text-dim">
          topic url — the dedupe key written to published_topics
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          className="w-full rounded border border-line-2 bg-ink px-2 py-1 text-fg focus:border-accent focus:outline-none disabled:opacity-50"
        />
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wider text-dim">topic title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          className="w-full rounded border border-line-2 bg-ink px-2 py-1 text-fg focus:border-accent focus:outline-none disabled:opacity-50"
        />
      </label>

      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
        placeholder="notes — paste the live post URL here"
        className="w-full rounded border border-line-2 bg-ink px-2 py-1 text-fg placeholder:text-dim focus:border-accent focus:outline-none disabled:opacity-50"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || platforms.length === 0 || url.trim() === "" || title.trim() === ""}
          className="rounded border border-ok/60 bg-ok/10 px-3 py-1 text-ok hover:bg-ok/20 disabled:opacity-40"
          title={
            platforms.length === 0 ? "tick the platform(s) you actually posted to" : undefined
          }
        >
          mark as published
        </button>
        <span className="text-dim">
          closes gate C and suppresses this story in tomorrow&apos;s ingest
        </span>
        {busy ? <span className="text-dim">working…</span> : null}
        {result ? <span className="text-ok">{result}</span> : null}
        {error ? <span className="text-bad">{error}</span> : null}
      </div>
    </div>
  );
}
