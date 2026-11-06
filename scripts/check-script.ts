/**
 * Gate-1 check for a /reel script — runs BEFORE any credits are spent.
 *
 *   pnpm exec tsx scripts/check-script.ts <script.json>
 *
 * Validates the schema, estimates runtime from word count (measured voice
 * pace, see WORDS_PER_S), counts the
 * ElevenLabs characters the voiceover will cost, and flags formula misses.
 * Exit code 1 on schema errors or hard failures; warnings don't fail.
 */
import { readFile } from "node:fs/promises";
import { ScriptJSON } from "../src/shared/schemas.js";
import { config } from "../src/config.js";
import { spokenText, deliveryWarnings, tagsIn } from "../src/tts/delivery.js";

/** Measured: Liam 3.1 w/s; Jessica ~2.65 w/s (315 words → 118.7 s on the watch reel). Use the slower. */
const WORDS_PER_S = 2.65;
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
const spoken = (b: { vo_text: string }) => spokenText(b.vo_text);
const totalWords = s.beats.reduce((n, b) => n + words(spoken(b)).length, 0);
const chars = s.beats.reduce((n, b) => n + b.vo_text.length, 0);
const estS = totalWords / WORDS_PER_S;
const { min, max } = config.video.targetDurationS;

// ── per-beat ────────────────────────────────────────────────────────────────
console.log(`\n${s.topic.title}\n${"─".repeat(Math.min(80, s.topic.title.length))}`);
for (const b of s.beats) {
  const w = words(spoken(b)).length;
  const est = w / WORDS_PER_S;
  console.log(
    `${b.id.padEnd(14)} ${(b.chapter ?? "—").padEnd(14)} ${est.toFixed(1).padStart(5)}s  ${b.visual.type}` +
      (b.visual.type === "generated" ? `:${b.visual.spec.scene}` : "") +
      (b.visual.type === "clip" || b.visual.type === "still" ? ` ${b.visual.source.split("/").pop()}` : ""),
  );
  if (est > b.max_duration_s) warnings.push(`${b.id}: ~${est.toFixed(1)}s of VO exceeds max_duration_s ${b.max_duration_s}`);
  for (const e of b.emphasis ?? []) {
    if (!spoken(b).toLowerCase().includes(e.toLowerCase())) {
      errors.push(`${b.id}: emphasis "${e}" is not in vo_text — it can't be highlighted`);
    }
  }
  const longest = Math.max(...spoken(b).split(/[.?!]+/).map((x) => words(x).length));
  for (const d of deliveryWarnings(b.vo_text)) warnings.push(`${b.id}: ${d}`);
  // A stated number needs a primary source on screen (research step, /reel 0.5).
  if (/\d/.test(spoken(b)) && !b.source_note && b.id !== s.beats[s.beats.length - 1]!.id) {
    errors.push(`${b.id}: states a number but has no source_note — research it and cite the primary source`);
  }
  if (longest > 18) warnings.push(`${b.id}: a ${longest}-word sentence — his lines rarely pass ~14`);
  if (!b.visual_brief) warnings.push(`${b.id}: no visual_brief — every line needs a picture`);
}

// ── formula ─────────────────────────────────────────────────────────────────
const vo = s.beats.map((b) => spoken(b).toLowerCase());
const hookWords = words(spoken(s.beats[0]!)).length;
if (hookWords > 28) warnings.push(`hook is ${hookWords} words — the first beat should land in ~5 s`);
if (!vo.slice(0, 2).some((t) => t.includes("?"))) warnings.push("no question in the first two beats — the open loop is missing");
if (!vo.some((t) => /\b(but here'?s|plot twist|the catch|but this isn'?t|but)\b/.test(t)))
  warnings.push("no mid-video twist ('but here's the catch')");
if (!vo.some((t) => /\bimagine\b/.test(t))) warnings.push("no 'Imagine…' analogy beat");
if (!vo.some((t) => /\b(i|i'm|my|me)\b/.test(t))) warnings.push("no personal-stake line (I / my)");
if (!/\b(follow|comment|send this|share)\b/.test(vo.at(-1) ?? "") && !/\b(follow|comment|send this|share)\b/.test(s.cta.vo_text.toLowerCase()))
  warnings.push("no CTA in the last beat");
if (!s.beats.some((b) => b.source_note)) warnings.push("no source_note on any beat — claims show no source");

// ── the user's asks: things they want said and shown ───────────────────────
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9%$€₹ ]+/g, " ").replace(/\s+/g, " ").trim();
const allSpoken = norm(s.beats.map((b) => spoken(b)).join(" "));
for (const line of s.requirements?.must_say ?? []) {
  if (!allSpoken.includes(norm(line))) errors.push(`must_say not in the script: "${line}"`);
}
const shown = s.beats.flatMap((b) =>
  b.visual.type === "still" || b.visual.type === "clip" ? [b.visual.source] : b.on_screen_image ? [b.on_screen_image.source] : [],
);
for (const src of s.requirements?.must_show ?? []) {
  if (!shown.includes(src)) errors.push(`must_show not used by any beat: ${src}`);
}

if (estS < min) errors.push(`~${estS.toFixed(0)}s is under the ${min}s floor`);
if (estS > max) errors.push(`~${estS.toFixed(0)}s is over the ${max}s ceiling`);

const tagCount = s.beats.reduce((n, b) => n + tagsIn(b.vo_text).length, 0);
console.log(
  `\n${s.beats.length} beats · ${totalWords} words · ~${estS.toFixed(0)}s (window ${min}–${max}s)` +
    ` · ${chars.toLocaleString()} characters to the TTS · ${tagCount} delivery tag(s)`,
);
if (warnings.length) console.log(`\nwarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
if (errors.length) {
  console.log(`\nERRORS:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nOK");
}
