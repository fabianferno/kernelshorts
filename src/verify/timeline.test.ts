import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseCss } from "../edit/styles.js";
import { studioCss, captionsStudioHtml, type StudioBeat } from "../edit/studio.js";
import { ScriptJSON } from "../shared/schemas.js";
import {
  wordSimilarity,
  checkCaptionSafeArea,
  checkScriptFidelity,
  transcribeFile,
  scriptSpokenText,
  measureCompositionTextBoxes,
  violationsFromMeasuredBoxes,
} from "./timeline.js";

/**
 * Unit tests use hand-written fixtures (allowed by PRD §0 for tests); the
 * two live tests at the bottom run the real verifiers against the real
 * M1 export on this machine.
 */

const RUN_DIR = join(process.env.HOME ?? "", "pipeline/runs/2026-08-12");
const EXPORT_PATH = join(RUN_DIR, "exports/m1-2026-08-12-master.mp4");

// ─── measured (hyperframes) safe area ───────────────────────────────────────

test("violationsFromMeasuredBoxes: a measured box inside both bands passes", () => {
  assert.deepEqual(
    violationsFromMeasuredBoxes([
      { id: "title-hook", kind: "title", top: 0.16, bottom: 0.32, centerY: 0.24, text: "Hook" },
      { id: "cap-line-hook-0", kind: "caption", top: 0.69, bottom: 0.749, centerY: 0.72, text: "hi" },
    ]),
    [],
  );
});

test("violationsFromMeasuredBoxes: measured boxes crossing either line are flagged, never estimated", () => {
  const v = violationsFromMeasuredBoxes([
    { id: "cap-low", kind: "caption", top: 0.72, bottom: 0.79, centerY: 0.755, text: "too low" },
    { id: "title-high", kind: "title", top: 0.06, bottom: 0.2, centerY: 0.13, text: "too high" },
  ]);
  assert.equal(v.length, 2);
  const bottom = v.find((x) => x.zone === "bottom")!;
  assert.equal(bottom.id, "cap-low");
  assert.ok(Math.abs(bottom.overshoot - 0.04) < 1e-9, `overshoot ${bottom.overshoot}`);
  const top = v.find((x) => x.zone === "top")!;
  assert.equal(top.id, "title-high");
  assert.ok(Math.abs(top.overshoot - 0.04) < 1e-9, `overshoot ${top.overshoot}`);
  assert.ok(v.every((x) => x.estimated === false));
});

/**
 * A REAL browser measurement of the REAL composition CSS. The page is written
 * from `compositionCss` + `titleHtml` + `captionsHtml`, so the geometry under
 * test is the geometry the renderer paints, not a fixture of it.
 *
 * The two assertions that matter are that the measurement finds EVERY caption
 * in one load — including groups whose windows never overlap, which is the
 * whole point of measuring layout rather than seeking — and that the boxes
 * land where studio.ts puts them.
 */
test("measureCompositionTextBoxes: measures every caption group in one load", async () => {
  const beat = (beatId: string, startS: number): StudioBeat => ({
    beatId,
    startS,
    durationS: 3,
    theme: "light",
    words: ["one", "two", "three"].map((w, i) => ({ word: w, startS: i * 0.3, endS: (i + 1) * 0.3 })),
  });
  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<style>${baseCss(1080, 1920)}${studioCss("")}</style></head>` +
    `<body><div id="root" data-width="1080" data-height="1920">` +
    // Two caption groups whose windows do NOT overlap: at any single instant
    // a seek-based measurement would see at most one of them.
    captionsStudioHtml(beat("hook", 0)).join("") +
    captionsStudioHtml(beat("why", 10)).join("") +
    `</div></body></html>`;

  const dir = await mkdtemp(join(tmpdir(), "safearea-"));
  const indexPath = join(dir, "index.html");
  try {
    await writeFile(indexPath, html, "utf8");
    const boxes = await measureCompositionTextBoxes(indexPath);

    assert.deepEqual(boxes.map((b) => b.id).sort(), ["cap-hook-0", "cap-why-0"]);
    for (const cap of boxes) {
      assert.equal(cap.kind, "caption");
      // studio.ts places captions at top: 196px of 1920.
      assert.ok(Math.abs(cap.top - 196 / 1920) < 0.003, `caption top ${cap.top}`);
      assert.ok(cap.bottom > cap.top, "caption box has real height");
    }
    // Same CSS, same canvas: these captions clear both bands.
    assert.deepEqual(violationsFromMeasuredBoxes(boxes), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkCaptionSafeArea: refuses to pass a composition with no text at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "safearea-empty-"));
  const indexPath = join(dir, "index.html");
  try {
    await writeFile(indexPath, `<!doctype html><html><body><div id="root"></div></body></html>`, "utf8");
    await assert.rejects(
      () => checkCaptionSafeArea({ indexPath }),
      /refusing to report a pass it did not measure/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── wordSimilarity ─────────────────────────────────────────────────────────

test("wordSimilarity: identical text ignoring case and punctuation is 1.0", () => {
  const r = wordSimilarity("Hello, world! This is it.", "hello world this is IT");
  assert.equal(r.ratio, 1);
  assert.equal(r.biggestDivergence, undefined);
});

test("wordSimilarity: a dropped run of words lowers the ratio and is reported", () => {
  const r = wordSimilarity("a b c d e f g h i j", "a b c d i j");
  assert.ok(Math.abs(r.ratio - 0.6) < 1e-9, `ratio ${r.ratio}`);
  assert.equal(r.biggestDivergence?.expected, "e f g h");
  assert.equal(r.biggestDivergence?.actual, "");
});

test("wordSimilarity: a doubled beat is reported as an insertion", () => {
  const r = wordSimilarity("one two three", "one two three one two three");
  assert.ok(r.ratio < 0.6, `ratio ${r.ratio}`);
  assert.equal(r.biggestDivergence?.actual, "one two three");
});

test("wordSimilarity: empty transcript scores zero rather than dividing by zero", () => {
  assert.equal(wordSimilarity("a b c", "").ratio, 0);
  assert.equal(wordSimilarity("", "").ratio, 1);
});

// ─── scriptSpokenText ───────────────────────────────────────────────────────

test("scriptSpokenText: only beats are spoken — script.cta is metadata, not extra VO", () => {
  const script = ScriptJSON.parse({
    run_id: "r",
    topic: { title: "t", url: "https://example.com" },
    target_duration_s: 30,
    music_mood: "upbeat-tech",
    beats: [
      {
        id: "hook",
        vo_text: "First line.",
        visual: { type: "stock", query: "code" },
        max_duration_s: 4,
      },
      {
        id: "cta",
        vo_text: "Follow for more.",
        visual: { type: "stock", query: "code" },
        max_duration_s: 4,
      },
    ],
    cta: { vo_text: "Follow for more.", on_screen_text: "Follow" },
  });
  assert.equal(scriptSpokenText(script), "First line. Follow for more.");
});

// ─── live runs against the real artifacts ───────────────────────────────────

test("LIVE: transcribeFile returns real words from the real export", async () => {
  const t = await transcribeFile(EXPORT_PATH);
  console.log(`\n--- soniox transcript (${t.text.split(/\s+/).length} words) ---\n${t.text}`);
  assert.ok(t.text.length > 50);
});

test("LIVE: script fidelity of the real export against the approved script", async () => {
  const state = JSON.parse(await readFile(join(RUN_DIR, "state.json"), "utf8")) as {
    script: unknown;
  };
  const script = ScriptJSON.parse(state.script);
  const result = await checkScriptFidelity(EXPORT_PATH, script);
  console.log("\n--- script_fidelity ---\n" + JSON.stringify(result, null, 2));
  assert.equal(result.name, "script_fidelity");
});
