import { test } from "node:test";
import assert from "node:assert/strict";
import { stutterWindows, isStuttering } from "./verify.js";

// Per-frame luma differences shaped like real captures (measured 2026-11-06).
const smooth = Array.from({ length: 120 }, (_, i) => 1 + 0.4 * Math.sin(i / 7));
// Wall-clock recorder over CPU WebGL: a jump every ~5 frames, near-zero between.
const juddery = Array.from({ length: 120 }, (_, i) => (i % 5 === 0 ? 3.2 : 0.02));

test("frame-stepped motion is smooth", () => {
  const s = stutterWindows(smooth);
  assert.equal(s.stuttering, 0);
  assert.equal(isStuttering(s), false);
});

test("motion that arrives in jumps is stutter", () => {
  const s = stutterWindows(juddery);
  assert.equal(s.stuttering, s.moving);
  assert.equal(isStuttering(s), true);
});

test("one real event (a screen flashing red) is not stutter", () => {
  const d = smooth.slice();
  d[40] = 25;
  assert.equal(isStuttering(stutterWindows(d)), false);
});

test("a still hold is neither moving nor stuttering", () => {
  const s = stutterWindows(Array(60).fill(0.01));
  assert.deepEqual(s, { moving: 0, stuttering: 0 });
});
