import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RubricScore, RunState, type ScriptJSON } from "../shared/schemas.js";
import { beatBoundaries, selectFrames, reviewVideo } from "./reviewer.js";

const RUN_DIR = join(process.env.HOME ?? "", "pipeline/runs/2026-08-12");
const EXPORT = join(RUN_DIR, "exports/m1-2026-08-12-master.mp4");

async function realState(): Promise<RunState> {
  return RunState.parse(JSON.parse(await readFile(join(RUN_DIR, "state.json"), "utf8")));
}

// ── Unit: beat boundaries come from script order + measured VO durations ─────

test("beatBoundaries accumulates measured VO durations in script beat order", () => {
  const script = {
    beats: [{ id: "a" }, { id: "b" }, { id: "c" }],
  } as unknown as ScriptJSON;
  const b = beatBoundaries(script, [
    { beat_id: "b", durationS: 2 },
    { beat_id: "a", durationS: 1 },
    { beat_id: "c", durationS: 3 },
  ]);
  assert.deepEqual(b, [
    { beat_id: "a", startS: 0, endS: 1 },
    { beat_id: "b", startS: 1, endS: 3 },
    { beat_id: "c", startS: 3, endS: 6 },
  ]);
});

test("beatBoundaries throws when a beat has no measured voiceover", () => {
  const script = { beats: [{ id: "a" }, { id: "b" }] } as unknown as ScriptJSON;
  assert.throws(
    () => beatBoundaries(script, [{ beat_id: "a", durationS: 1 }]),
    /no measured voiceover.*b/i,
  );
});

// ── Unit: frame budget ───────────────────────────────────────────────────────

test("selectFrames keeps every frame when under the cap", () => {
  const frames = ["f1.jpg", "f2.jpg", "f3.jpg"];
  const picked = selectFrames(frames, 1, [{ beat_id: "a", startS: 0, endS: 3 }], 10);
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map((p) => p.path), frames);
});

test("selectFrames caps the set but always keeps beat-boundary frames", () => {
  const frames = Array.from({ length: 34 }, (_, i) => `f${i}.jpg`);
  const boundaries = [
    { beat_id: "a", startS: 0, endS: 10 },
    { beat_id: "b", startS: 10, endS: 22 },
    { beat_id: "c", startS: 22, endS: 34 },
  ];
  const picked = selectFrames(frames, 1, boundaries, 12);
  assert.equal(picked.length, 12);
  // frame index for t seconds at 1fps is floor(t) (frame n covers [n, n+1))
  for (const t of [0, 10, 22]) {
    assert.ok(
      picked.some((p) => Math.abs(p.tS - t) < 1),
      `boundary ${t}s missing from selection`,
    );
  }
  // strictly increasing in time, no duplicates
  const ts = picked.map((p) => p.tS);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(new Set(ts).size, ts.length);
});

// ── Real review of the real M1 export ────────────────────────────────────────

test("reviewVideo returns a schema-valid rubric for the real M1 export", { timeout: 600_000 }, async () => {
  const state = await realState();
  const script = state.script!;
  const workspace = await mkdtemp(join(tmpdir(), "review-"));

  const result = await reviewVideo({
    videoPath: EXPORT,
    script,
    workspace,
    voiceover: state.manifest!.voiceover,
  });

  // Schema is the contract — parse again here so the test fails loudly if
  // reviewVideo ever returns something unvalidated.
  RubricScore.parse(result.rubric);
  assert.ok(result.frameCount > 0, "no frames sent");
  assert.ok(result.inputTokens > 0, "no input token count reported");

  console.log(
    JSON.stringify(
      {
        frameCount: result.frameCount,
        attempts: result.attempts,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        loudness: result.loudness,
        rubric: result.rubric,
      },
      null,
      2,
    ),
  );
});
