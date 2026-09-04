import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compositionCss, titleHtml } from "../edit/styles.js";
import { captionsHtml, type WordTiming } from "../edit/captions.js";
import { PalmierClient } from "../palmier/client.js";
import { ScriptJSON } from "../shared/schemas.js";
import {
  findVideoGaps,
  findSafeAreaViolations,
  wordSimilarity,
  checkTimelineGaps,
  checkCaptionSafeArea,
  checkScriptFidelity,
  transcribeFile,
  scriptSpokenText,
  measureCompositionTextBoxes,
  violationsFromMeasuredBoxes,
  type TimelineLike,
} from "./timeline.js";

/**
 * Unit tests use hand-written timeline fixtures (allowed by PRD §0 for tests);
 * the three live tests at the bottom run the real verifiers against the real
 * M1 export and the real Palmier project on this machine.
 */

const RUN_DIR = join(process.env.HOME ?? "", "pipeline/runs/2026-08-12");
const EXPORT_PATH = join(RUN_DIR, "exports/m1-2026-08-12-master.mp4");
const PROJECT_PATH = join(
  process.env.HOME ?? "",
  "Documents/Palmier Pro/m1-2026-08-12.palmier",
);

// ─── findVideoGaps ──────────────────────────────────────────────────────────

test("findVideoGaps: contiguous footage track reports no gap", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      {
        index: 0,
        type: "video",
        clips: [
          { id: "a", frames: [0, 150] },
          { id: "b", frames: [150, 300] },
        ],
      },
    ],
  };
  assert.deepEqual(findVideoGaps(t), []);
});

test("findVideoGaps: a hole between footage clips is a gap", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      {
        index: 0,
        type: "video",
        gaps: [[100, 200]],
        clips: [
          { id: "a", frames: [0, 100] },
          { id: "b", frames: [200, 300] },
        ],
      },
    ],
  };
  assert.deepEqual(findVideoGaps(t), [{ startFrame: 100, endFrame: 200, startS: 100 / 30, endS: 200 / 30 }]);
});

test("findVideoGaps: footage ending before the timeline is a trailing gap", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [{ index: 0, type: "video", clips: [{ id: "a", frames: [0, 240] }] }],
  };
  assert.deepEqual(findVideoGaps(t), [
    { startFrame: 240, endFrame: 300, startS: 8, endS: 10 },
  ]);
});

test("findVideoGaps: a gap on a text-only video track is not black", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      {
        index: 0,
        type: "video",
        gaps: [[100, 200]],
        clips: [
          { id: "t1", mediaType: "text", frames: [0, 100] },
          { id: "t2", mediaType: "text", frames: [200, 300] },
        ],
      },
      { index: 1, type: "video", clips: [{ id: "a", frames: [0, 300] }] },
    ],
  };
  assert.deepEqual(findVideoGaps(t), []);
});

test("findVideoGaps: a gap on a caption track is not black", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      {
        index: 0,
        type: "video",
        gaps: [[10, 40]],
        captionGroups: [{ captionGroupId: "G1", frameRange: [0, 300] }],
        clips: [],
      },
      { index: 1, type: "video", clips: [{ id: "a", frames: [0, 300] }] },
    ],
  };
  assert.deepEqual(findVideoGaps(t), []);
});

test("findVideoGaps: gaps on audio tracks are ignored", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      { index: 0, type: "video", clips: [{ id: "a", frames: [0, 300] }] },
      {
        index: 1,
        type: "audio",
        gaps: [[151, 155]],
        clips: [
          { id: "vo1", mediaType: "audio", frames: [0, 151] },
          { id: "vo2", mediaType: "audio", frames: [155, 300] },
        ],
      },
    ],
  };
  assert.deepEqual(findVideoGaps(t), []);
});

test("findVideoGaps: a lower footage track covers a hole in the upper one", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    tracks: [
      {
        index: 0,
        type: "video",
        gaps: [[100, 200]],
        clips: [
          { id: "img1", mediaType: "image", frames: [0, 100] },
          { id: "img2", mediaType: "image", frames: [200, 300] },
        ],
      },
      { index: 1, type: "video", clips: [{ id: "base", frames: [0, 300] }] },
    ],
  };
  assert.deepEqual(findVideoGaps(t), []);
});

// ─── findSafeAreaViolations ─────────────────────────────────────────────────

test("findSafeAreaViolations: a centred text box in the safe band passes", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        clips: [
          {
            id: "T1",
            mediaType: "text",
            frames: [0, 100],
            textContent: "Votes up.\nTime down.",
            textStyle: { fontSize: 46 },
            transform: { centerY: 0.24, height: 0.127 },
          },
        ],
      },
    ],
  };
  assert.deepEqual(findSafeAreaViolations(t), []);
});

test("findSafeAreaViolations: a box whose CENTRE is safe but whose bottom edge dips into the bottom 25% is flagged", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        clips: [
          {
            id: "T2",
            mediaType: "text",
            frames: [0, 100],
            textContent: "one line",
            textStyle: { fontSize: 46 },
            transform: { centerY: 0.72, height: 0.14 },
          },
        ],
      },
    ],
  };
  const v = findSafeAreaViolations(t);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.id, "T2");
  assert.equal(v[0]!.zone, "bottom");
  // bottom edge 0.72 + 0.07 = 0.79, overshooting the 0.75 line by 0.04
  assert.ok(Math.abs(v[0]!.overshoot - 0.04) < 1e-9, `overshoot ${v[0]!.overshoot}`);
});

test("findSafeAreaViolations: a box riding into the top 10% is flagged", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        clips: [
          {
            id: "T3",
            mediaType: "text",
            frames: [0, 100],
            textContent: "title",
            textStyle: { fontSize: 46 },
            transform: { centerY: 0.12, height: 0.1 },
          },
        ],
      },
    ],
  };
  const v = findSafeAreaViolations(t);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.zone, "top");
  assert.ok(Math.abs(v[0]!.overshoot - 0.03) < 1e-9, `overshoot ${v[0]!.overshoot}`);
});

test("findSafeAreaViolations: caption groups are measured from fontSize since they report no box height", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        captionGroups: [
          {
            captionGroupId: "G1",
            frameRange: [0, 300],
            shared: {
              mediaType: "text",
              textStyle: { fontSize: 31 },
              transform: { centerY: 0.66 },
            },
          },
        ],
        clips: [],
      },
    ],
  };
  assert.deepEqual(findSafeAreaViolations(t), []);
});

test("findSafeAreaViolations: a low caption group is flagged by its estimated box", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        captionGroups: [
          {
            captionGroupId: "G2",
            frameRange: [0, 300],
            shared: {
              mediaType: "text",
              textStyle: { fontSize: 72 },
              transform: { centerY: 0.78 },
            },
          },
        ],
        clips: [],
      },
    ],
  };
  const v = findSafeAreaViolations(t);
  assert.equal(v.length, 1);
  assert.equal(v[0]!.id, "G2");
  assert.equal(v[0]!.kind, "captionGroup");
  assert.equal(v[0]!.zone, "bottom");
});

test("findSafeAreaViolations: non-text clips are not safe-area candidates", () => {
  const t: TimelineLike = {
    fps: 30,
    totalFrames: 300,
    height: 1920,
    tracks: [
      {
        index: 0,
        type: "video",
        clips: [{ id: "V", frames: [0, 300], transform: { centerY: 0.9, height: 2.4 } }],
      },
    ],
  };
  assert.deepEqual(findSafeAreaViolations(t), []);
});

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
 * The two assertions that matter are that the measurement finds EVERY text
 * element in one load — including caption lines whose windows never overlap,
 * which is the whole point of measuring layout rather than seeking — and that
 * the boxes land on the calibrated centres (0.24 / 0.72).
 */
test("measureCompositionTextBoxes: measures every title and caption line in one load", async () => {
  const words = (start: number): WordTiming[] =>
    ["one", "two", "three"].map((w, i) => ({ word: w, startS: start + i * 0.3, endS: start + (i + 1) * 0.3 }));
  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<style>${compositionCss({ width: 1080, height: 1920, fontFaces: "" })}</style></head>` +
    `<body><div id="root" data-width="1080" data-height="1920">` +
    titleHtml({
      beatId: "hook",
      text: "A measured title",
      startS: 0,
      durationS: 3,
      variant: { font: "coolvetica", treatment: "boxLight" },
    }) +
    // Two caption lines whose windows do NOT overlap: at any single instant a
    // seek-based measurement would see at most one of them.
    captionsHtml({ beatId: "hook", startFrame: 0, words: words(0) }) +
    captionsHtml({ beatId: "why", startFrame: 300, words: words(0) }) +
    `</div></body></html>`;

  const dir = await mkdtemp(join(tmpdir(), "safearea-"));
  const indexPath = join(dir, "index.html");
  try {
    await writeFile(indexPath, html, "utf8");
    const boxes = await measureCompositionTextBoxes(indexPath);

    assert.deepEqual(
      boxes.map((b) => b.id).sort(),
      ["cap-line-hook-0", "cap-line-why-0", "title-hook"],
    );
    const title = boxes.find((b) => b.id === "title-hook")!;
    assert.equal(title.kind, "title");
    assert.ok(Math.abs(title.centerY - 0.24) < 0.005, `title centreY ${title.centerY}`);
    assert.ok(title.bottom > title.top, "title box has real height");
    for (const cap of boxes.filter((b) => b.kind === "caption")) {
      assert.ok(Math.abs(cap.centerY - 0.72) < 0.005, `caption centreY ${cap.centerY}`);
      assert.ok(cap.bottom > cap.top, "caption box has real height");
    }
    // Same CSS, same canvas: this composition clears both bands.
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

test("LIVE: timeline verifiers against the real m1-2026-08-12 project", async () => {
  const client = new PalmierClient();
  await client.connect();
  try {
    await client.manageProject({ action: "open", path: PROJECT_PATH });
    const gaps = await checkTimelineGaps(client);
    const safe = await checkCaptionSafeArea(client);
    console.log("\n--- timeline_gaps ---\n" + JSON.stringify(gaps, null, 2));
    console.log("\n--- caption_safe_area ---\n" + JSON.stringify(safe, null, 2));
    assert.equal(gaps.name, "timeline_gaps");
    assert.equal(safe.name, "caption_safe_area");
  } finally {
    await client.manageProject({ action: "close" });
    await client.close();
  }
});

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
