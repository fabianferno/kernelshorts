"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The three actions PRD §2 specifies. approve-with-comment is deliberately not
 * a separate button that hides the comment box until clicked: the comment is
 * what feeds the next edit brief, so the field is always visible and always
 * submitted with whichever decision you make.
 */
export function GateActions({
  runId,
  gate,
  disabled,
}: {
  runId: string;
  gate: string;
  disabled?: boolean;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function resolve(status: "approved" | "rejected") {
    if (status === "rejected" && comment.trim() === "") {
      setError("A rejection needs a reason — it becomes the rewrite brief.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/gates/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          gate,
          status,
          comment: comment.trim() === "" ? undefined : comment.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setComment("");
      // The gate row, the run's phase badge and the inbox count all move on one
      // decision; refreshing the server render is cheaper than mirroring that
      // state in the client.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || pending || disabled;

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={busy}
        rows={2}
        placeholder="comment — becomes an input to the next edit brief (required to reject)"
        className="w-full resize-y rounded border border-line-2 bg-ink px-2 py-1.5 text-fg placeholder:text-dim focus:border-accent focus:outline-none disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => resolve("approved")}
          disabled={busy}
          className="rounded border border-ok/60 bg-ok/10 px-3 py-1 text-ok hover:bg-ok/20 disabled:opacity-40"
        >
          {comment.trim() ? "approve with comment" : "approve"}
        </button>
        <button
          onClick={() => resolve("rejected")}
          disabled={busy}
          className="rounded border border-bad/60 bg-bad/10 px-3 py-1 text-bad hover:bg-bad/20 disabled:opacity-40"
        >
          reject
        </button>
        {busy ? <span className="text-dim">working…</span> : null}
        {error ? <span className="text-bad">{error}</span> : null}
      </div>
    </div>
  );
}
