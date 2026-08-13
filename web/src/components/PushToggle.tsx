"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Enables web push for gate-open, escalation and failure (PRD §2).
 *
 * It reports what is actually true rather than what was clicked. The three
 * states that get conflated and must not be: the browser permission
 * (granted/denied/default), whether a PushSubscription exists in THIS browser,
 * and whether the server has it stored. A button that says "subscribed" after
 * a denied permission prompt is how a gate sits unanswered all night.
 */
type State =
  | { kind: "checking" }
  | { kind: "unsupported"; why: string }
  | { kind: "server-unconfigured" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "error"; message: string };

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 *
 * The explicit `ArrayBuffer` type argument matters: lib.dom types
 * `applicationServerKey` as `BufferSource`, which excludes a `Uint8Array` whose
 * buffer might be a SharedArrayBuffer. Allocating the buffer here pins it.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function PushToggle() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      // Safari only exposes PushManager to installed web apps, and any browser
      // on plain http:// beyond localhost has no service workers at all.
      setState({
        kind: "unsupported",
        why: window.isSecureContext
          ? "this browser has no PushManager"
          : "push needs a secure context (https or localhost)",
      });
      return;
    }

    const response = await fetch("/api/push/subscribe", { cache: "no-store" });
    const { configured } = (await response.json()) as { configured: boolean };
    if (!configured) {
      setState({ kind: "server-unconfigured" });
      return;
    }

    if (Notification.permission === "denied") {
      setState({ kind: "denied" });
      return;
    }

    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const existing = await registration?.pushManager.getSubscription();
    setState({ kind: existing ? "on" : "off" });
  }, []);

  useEffect(() => {
    void refresh().catch((e) =>
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [refresh]);

  async function enable() {
    setBusy(true);
    try {
      const { publicKey } = (await (
        await fetch("/api/push/subscribe", { cache: "no-store" })
      ).json()) as { publicKey: string | null };
      if (!publicKey) throw new Error("server has no VAPID public key");

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "denied" } : { kind: "off" });
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      // register() resolves before the worker is active; subscribing against an
      // installing worker throws InvalidStateError.
      await navigator.serviceWorker.ready;

      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          // Required to be true by every browser: a push must always produce a
          // visible notification.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      const saved = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          label: navigator.userAgent.slice(0, 120),
        }),
      });
      if (!saved.ok) {
        const body = await saved.json().catch(() => ({}));
        throw new Error(body.error ?? `server refused the subscription (${saved.status})`);
      }
      setState({ kind: "on" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      // The server row is left in place deliberately: the next send gets a
      // 410 from the push service and push.ts prunes it there, which is the
      // only signal that is actually authoritative.
      setState({ kind: "off" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const body = {
    checking: <span className="text-dim">notifications…</span>,
    unsupported: (
      <span className="text-dim" title={state.kind === "unsupported" ? state.why : undefined}>
        push unsupported
      </span>
    ),
    "server-unconfigured": (
      <span className="text-dim" title="VAPID_PUBLIC_KEY is not set on the server">
        push not configured
      </span>
    ),
    denied: (
      <span className="text-bad" title="Reset it in the browser's site settings">
        notifications blocked
      </span>
    ),
    off: (
      <button onClick={enable} disabled={busy} className="text-accent hover:underline disabled:opacity-50">
        {busy ? "enabling…" : "enable notifications"}
      </button>
    ),
    on: (
      <span className="text-ok">
        notifications on{" "}
        <button onClick={disable} disabled={busy} className="text-dim hover:underline">
          (disable)
        </button>
      </span>
    ),
    error: (
      <span className="text-bad">
        push: {state.kind === "error" ? state.message : ""}{" "}
        <button onClick={enable} className="text-dim hover:underline">
          retry
        </button>
      </span>
    ),
  }[state.kind];

  return <div className="ml-auto">{body}</div>;
}
