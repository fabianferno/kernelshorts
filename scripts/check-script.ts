/**
 * Gate-1 check for a /reel script — runs BEFORE any credits are spent.
 *
 *   pnpm exec tsx scripts/check-script.ts <script.json>
 *
 * Validates the schema, estimates runtime from word count (Liam on
 * eleven_multilingual_v2 measured 3.1 words/s on 2026-11-06), counts the
 * ElevenLabs characters the voiceover will cost, and flags formula misses.
 * Exit code 1 on schema errors or hard failures; warnings don't fail.
 */
import { readFile } from "node:fs/promises";
import { ScriptJSON } from "../src/shared/schemas.js";
import { config } from "../src/config.js";

const WORDS_PER_S = 3.1;
const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/check-script.ts <script.json>");
  process.exit(2);
}

const parsed = ScriptJSON.safeParse({ run_id: "pending", ...JSON.parse(await readFile(path, "utf8")) });
if (!parsed.success) {
  console.error(`SCHEMA ERRORS:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  process.exit(1);
}
const s = parsed.data;
const errors: string[] = [];
const warnings: string[] = [];

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);
const totalWords = s.beats.reduce((n, b) => n + words(b.vo_text).length, 0);
const chars = s.beats.reduce((n, b) => n + b.vo_text.length, 0);
const estS = totalWords / WORDS_PER_S;
const { min, max } = config.video.targetDurationS;

// ── per-beat ────────────────────────────────────────────────────────────────
console.log(`\n${s.topic.title}\n${"─".repeat(Math.min(80, s.topic.title.length))}`);
for (const b of s.beats) {
  const w = words(b.vo_text).length;
  const est = w / WORDS_PER_S;
  console.log(
    `${b.id.padEnd(14)} ${(b.chapter ?? "—").padEnd(14)} ${est.toFixed(1).padStart(5)}s  ${b.visual.type}` +
      (b.visual.type === "generated" ? `:${b.visual.spec.scene}` : ""),
  );
  if (est > b.max_duration_s) warnings.push(`${b.id}: ~${est.toFixed(1)}s of VO exceeds max_duration_s ${b.max_duration_s}`);
  for (const e of b.emphasis ?? []) {
    if (!b.vo_text.toLowerCase().includes(e.toLowerCase())) {
      errors.push(`${b.id}: emphasis "${e}" is not in vo_text — it can't be highlighted`);
    }
  }
  const longest = Math.max(...b.vo_text.split(/[.?!]+/).map((x) => words(x).length));
  if (longest > 18) warnings.push(`${b.id}: a ${longest}-word sentence — his lines rarely pass ~14`);
  if (!b.visual_brief) warnings.push(`${b.id}: no visual_brief — every line needs a picture`);
}

// ── formula ─────────────────────────────────────────────────────────────────
const vo = s.beats.map((b) => b.vo_text.toLowerCase());
const hookWords = words(s.beats[0]!.vo_text).length;
if (hookWords > 28) warnings.push(`hook is ${hookWords} words — the first beat should land in ~5 s`);
if (!vo.slice(0, 2).some((t) => t.includes("?"))) warnings.push("no question in the first two beats — the open loop is missing");
if (!vo.some((t) => /\b(but here'?s|plot twist|the catch|but this isn'?t|but)\b/.test(t)))
  warnings.push("no mid-video twist ('but here's the catch')");
if (!vo.some((t) => /\bimagine\b/.test(t))) warnings.push("no 'Imagine…' analogy beat");
if (!vo.some((t) => /\b(i|i'm|my|me)\b/.test(t))) warnings.push("no personal-stake line (I / my)");
if (!/\b(follow|comment|send this|share)\b/.test(vo.at(-1) ?? "") && !/\b(follow|comment|send this|share)\b/.test(s.cta.vo_text.toLowerCase()))
  warnings.push("no CTA in the last beat");
if (!s.beats.some((b) => b.source_note)) warnings.push("no source_note on any beat — claims show no source");

if (estS < min) errors.push(`~${estS.toFixed(0)}s is under the ${min}s floor`);
if (estS > max) errors.push(`~${estS.toFixed(0)}s is over the ${max}s ceiling`);

console.log(
  `\n${s.beats.length} beats · ${totalWords} words · ~${estS.toFixed(0)}s (window ${min}–${max}s)` +
    ` · ${chars.toLocaleString()} ElevenLabs characters`,
);
if (warnings.length) console.log(`\nwarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
if (errors.length) {
  console.log(`\nERRORS:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nOK");
}
