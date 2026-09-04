import test from "node:test";
import assert from "node:assert/strict";
import { planBeats, BEAT_PAD_FRAMES } from "./plan-beats.js";
import type { ScriptJSON, AssetManifest } from "../shared/schemas.js";

/** Minimal fixtures — only the fields planBeats reads. */
const script = {
  run_id: "test-run",
  beats: [
    { id: "hook", vo_text: "First line.", on_screen_text: "HOOK" },
    { id: "body", vo_text: "Second line.", on_screen_text: undefined },
  ],
} as unknown as ScriptJSON;

const manifest = {
  voiceover: [
    { beat_id: "hook", path: "/vo/hook.wav", durationS: 2 },
    { beat_id: "body", path: "/vo/body.wav", durationS: 3 },
  ],
  assets: [
    { beat_id: "hook", path: "/v/a.mp4", kind: "stock", width: 1280, height: 720, durationS: 10 },
    { beat_id: "body", path: "/v/b.mp4", kind: "screenrec", width: 1280, height: 720, durationS: 10 },
  ],
  overlays: [],
} as unknown as AssetManifest;

test("beats are laid out contiguously, each padded by BEAT_PAD_FRAMES", () => {
  const plan = planBeats(script, manifest);
  assert.equal(plan.length, 2);
  // 2s at 30fps = 60 frames, + 4 pad = 64
  assert.deepEqual(
    plan.map((p) => [p.startFrame, p.endFrame]),
    [[0, 60 + BEAT_PAD_FRAMES], [64, 64 + 90 + BEAT_PAD_FRAMES]],
  );
});

test("each beat ends exactly where the next begins — no gap, no overlap", () => {
  const plan = planBeats(script, manifest);
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i]!.startFrame, plan[i - 1]!.endFrame);
  }
});

test("the plan carries the spoken words through for caption ground truth", () => {
  const plan = planBeats(script, manifest);
  assert.equal(plan[0]!.voText, "First line.");
  assert.equal(plan[0]!.onScreenText, "HOOK");
});

test("a beat with no voiceover is a hard error, not a skipped beat", () => {
  const broken = { ...script, beats: [...script.beats, { id: "orphan", vo_text: "x" }] } as ScriptJSON;
  assert.throws(() => planBeats(broken, manifest), /No voiceover clip for beat "orphan"/);
});

test("a beat with no visual asset is a hard error", () => {
  const noAsset = {
    ...manifest,
    assets: manifest.assets.filter((a) => a.beat_id !== "body"),
  } as AssetManifest;
  assert.throws(() => planBeats(script, noAsset), /No visual asset for beat "body"/);
});
