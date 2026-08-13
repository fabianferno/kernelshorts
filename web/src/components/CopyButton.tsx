"use client";

import { useState } from "react";

/**
 * The publish screen is used with a YouTube upload form open in the other tab,
 * so every field the user has to retype gets one of these. It reports failure
 * rather than silently doing nothing: `navigator.clipboard` is undefined on a
 * plain-http origin (this dashboard is reachable at http://<mac>.local:3111 as
 * well as localhost), and a copy button that lies is worse than none — the user
 * pastes stale clipboard content into a real upload.
 *
 * The execCommand fallback is deprecated and still the only thing that works on
 * an insecure origin.
 */
export function CopyButton({
  text,
  label = "copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        const el = document.createElement("textarea");
        el.value = text;
        // Off-screen but focusable; display:none would make execCommand a no-op.
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand("copy");
        el.remove();
      }
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1800);
  }

  return (
    <button
      onClick={copy}
      title={state === "failed" ? "clipboard unavailable — select the text and copy manually" : text}
      className={
        "shrink-0 rounded border px-2 py-0.5 " +
        {
          idle: "border-line-2 text-muted hover:border-accent hover:text-accent",
          copied: "border-ok/60 bg-ok/10 text-ok",
          failed: "border-bad/60 bg-bad/10 text-bad",
        }[state] +
        " " +
        className
      }
    >
      {state === "copied" ? "copied" : state === "failed" ? "copy failed" : label}
    </button>
  );
}
