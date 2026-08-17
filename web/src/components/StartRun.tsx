"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Starts today's run on the backend daemon.
 *
 * Deliberately not disabled when a run already exists for today: the daemon
 * holds the single-run lock and answers 409, and it is the only thing that
 * actually knows. A button greyed out from a stale page render would be a
 * guess, and the failure mode of guessing wrong is refusing to start a run
 * after a crash — exactly the case this is meant to cover.
 */
export function StartRun({ defaultVoice }: { defaultVoice: string }) {
  const [voice, setVoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function submit() {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/runs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(voice.trim() === "" ? {} : { voice: voice.trim() }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      // Research takes minutes before anything is written, so the run will not
      // appear in the table on the next refresh. Say that rather than letting
      // an empty row read as a failure.
      setResult(`started ${body.runId} — research is running; the row appears shortly`);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || pending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={submit}
        disabled={busy}
        className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-accent hover:bg-accent/20 disabled:opacity-40"
      >
        start run
      </button>
      <input
        value={voice}
        onChange={(e) => setVoice(e.target.value)}
        disabled={busy}
        placeholder={`voice — default ${defaultVoice}`}
        className="w-56 rounded border border-line-2 bg-ink px-2 py-1 text-fg placeholder:text-dim focus:border-accent focus:outline-none disabled:opacity-50"
      />
      {busy ? <span className="text-dim">working…</span> : null}
      {result ? <span className="text-ok">{result}</span> : null}
      {error ? <span className="text-bad">{error}</span> : null}
    </div>
  );
}
