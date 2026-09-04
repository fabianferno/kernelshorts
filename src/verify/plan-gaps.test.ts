import test from "node:test";
import assert from "node:assert/strict";
import { findPlanGaps } from "./plan-gaps.js";
import type { BeatPlan } from "../edit/plan-beats.js";

const beat = (id: string, s: number, e: number) =>
  ({ beatId: id, startFrame: s, endFrame: e } as BeatPlan);

test("a contiguous plan has no gaps", () => {
  assert.deepEqual(findPlanGaps([beat("a", 0, 60), beat("b", 60, 120)]), []);
});

test("a hole between beats is reported with its frame range", () => {
  const gaps = findPlanGaps([beat("a", 0, 60), beat("b", 64, 120)]);
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0]!.startFrame, gaps[0]!.endFrame], [60, 64]);
});

test("a plan that does not start at frame zero is a gap", () => {
  assert.equal(findPlanGaps([beat("a", 3, 60)]).length, 1);
});

test("overlapping beats are reported too — they mean drifted boundaries", () => {
  assert.equal(findPlanGaps([beat("a", 0, 60), beat("b", 50, 120)]).length, 1);
});
