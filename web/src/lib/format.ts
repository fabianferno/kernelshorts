/** Shared by server and client components — no imports with side effects. */

export function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function fmtDuration(ms: number): string {
  if (ms === 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Wall-clock time of day. The run record's dates are the ordering key; the
 *  event feed only ever needs "when, relative to the events around it". */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export const PHASE_COLOR: Record<string, string> = {
  research: "text-accent",
  script: "text-accent",
  tts: "text-accent",
  assets: "text-accent",
  edit: "text-warn",
  review: "text-warn",
  export: "text-warn",
  publish: "text-gate",
  done: "text-ok",
  failed: "text-bad",
};

export const KIND_COLOR: Record<string, string> = {
  tool_call: "text-accent",
  log: "text-muted",
  gate_open: "text-gate",
  gate_closed: "text-gate",
  error: "text-bad",
  artifact: "text-ok",
};

export const GATE_LABEL: Record<string, string> = {
  A_script: "Gate A · script approval",
  B_review_escalation: "Gate B · review escalation",
  C_publish: "Gate C · publish approval",
};
