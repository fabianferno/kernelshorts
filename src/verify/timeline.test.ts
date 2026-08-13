import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
