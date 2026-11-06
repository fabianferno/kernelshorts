import { test } from "node:test";
import assert from "node:assert/strict";
import { POSES, posesForWords, getPose, DEFAULT_POSE } from "./poses.js";

test("pose ids are unique and the default exists", () => {
  const ids = POSES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(getPose(DEFAULT_POSE).id, DEFAULT_POSE);
});

test("no trigger is claimed by two poses", () => {
  const seen = new Map<string, string>();
  for (const p of POSES) {
    for (const t of p.triggers) {
      assert.ok(!seen.has(t), `"${t}" is a trigger for both ${seen.get(t)} and ${p.id}`);
      seen.set(t, p.id);
    }
  }
});

test("maps trigger words, ignoring case and punctuation", () => {
  const out = posesForWords(["First,", "the", "talent.", "Second:", "the", "labs"]);
  assert.deepEqual(out, ["point-up", undefined, undefined, "two", undefined, undefined]);
});

test("a multi-word trigger wins over its single-word tail", () => {
  // "did you know" → point-up at "did"; "so why" → shrug at "so".
  const out = posesForWords(["Did", "you", "know", "so", "why"]);
  assert.equal(out[0], "point-up");
  assert.equal(out[3], "shrug");
});
