import test from "node:test";
import assert from "node:assert/strict";
import { Beat, type VisualSpec } from "../shared/schemas.js";
import { assertVisualMix } from "./script.js";

const SCREENREC: VisualSpec = {
  type: "screenrec",
  url: "https://example.com",
  viewport: "mobile",
  actions: ["goto"],
};
const STOCK: VisualSpec = { type: "stock", query: "server room", preferVault: true };
const GENERATED: VisualSpec = { type: "generated", spec: { scene: "particles", mood: "network" } };

function beats(...visuals: VisualSpec[]) {
  return visuals.map((visual, i) =>
    Beat.parse({ id: `b${i}`, vo_text: "a line of narration", visual, max_duration_s: 6 }),
  );
}

test("a script with no generated beats passes", () => {
  assertVisualMix(beats(SCREENREC, STOCK, STOCK, STOCK));
});

test("half the beats generated is allowed", () => {
  assertVisualMix(beats(SCREENREC, STOCK, GENERATED, GENERATED));
});

test("an odd beat count rounds the cap up", () => {
  assertVisualMix(beats(SCREENREC, STOCK, GENERATED, GENERATED, GENERATED));
});

test("more than half generated is rejected", () => {
  assert.throws(
    () => assertVisualMix(beats(SCREENREC, GENERATED, GENERATED, GENERATED)),
    /3 of 4 beats use visual.type "generated"/,
  );
});

test("an all-generated script is rejected", () => {
  assert.throws(
    () => assertVisualMix(beats(GENERATED, GENERATED, GENERATED, GENERATED)),
    /animated slide deck/,
  );
});
