import test from "node:test";
import assert from "node:assert/strict";
import { framesToSeconds, dbToGain } from "./units.js";

test("frames convert to seconds at the project frame rate", () => {
  assert.equal(framesToSeconds(0), 0);
  assert.equal(framesToSeconds(30), 1);
  assert.equal(framesToSeconds(45), 1.5);
});

test("frame conversion is rounded to microseconds, not left as float noise", () => {
  // 64 / 30 = 2.1333333333333333 — must not serialize 17 digits into the HTML.
  assert.equal(framesToSeconds(64), 2.133333);
});

test("dB converts to linear gain", () => {
  assert.equal(dbToGain(0), 1);
  // -20 dB is exactly a tenth of the amplitude.
  assert.equal(dbToGain(-20), 0.1);
  // -6 dB is roughly half.
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-6);
});

test("the source-audio mute level is effectively silent but not negative", () => {
  const muted = dbToGain(-60);
  assert.ok(muted > 0);
  assert.ok(muted < 0.002);
});
