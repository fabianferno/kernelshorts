import test from "node:test";
import assert from "node:assert/strict";
import { nextSlot, decideDue, zonedToUtc, parseLocalDateTime, localParts } from "./slots.js";

const IST = { time: "19:30", timezone: "Asia/Kolkata" };

test("zonedToUtc: 19:30 IST is 14:00 UTC", () => {
  const t = zonedToUtc({ year: 2026, month: 11, day: 8, hour: 19, minute: 30 }, "Asia/Kolkata");
  assert.equal(t.toISOString(), "2026-11-08T14:00:00.000Z");
});

test("zonedToUtc handles a DST zone on both sides of the change", () => {
  // New York: EDT (-4) until 1 Nov 2026, EST (-5) after.
  const before = zonedToUtc({ year: 2026, month: 10, day: 30, hour: 19, minute: 30 }, "America/New_York");
  const after = zonedToUtc({ year: 2026, month: 11, day: 3, hour: 19, minute: 30 }, "America/New_York");
  assert.equal(before.toISOString(), "2026-10-30T23:30:00.000Z");
  assert.equal(after.toISOString(), "2026-11-04T00:30:00.000Z");
});

test("nextSlot: today's slot when it is far enough ahead", () => {
  const now = new Date("2026-11-08T10:00:00Z"); // 15:30 IST
  assert.equal(nextSlot(now, IST).toISOString(), "2026-11-08T14:00:00.000Z");
});

test("nextSlot: tomorrow when today's slot is inside the lead time or past", () => {
  const close = new Date("2026-11-08T13:50:00Z"); // 19:20 IST, lead 20 min
  assert.equal(nextSlot(close, IST).toISOString(), "2026-11-09T14:00:00.000Z");
  const past = new Date("2026-11-08T16:00:00Z"); // 21:30 IST
  assert.equal(nextSlot(past, IST).toISOString(), "2026-11-09T14:00:00.000Z");
});

test("nextSlot: skips days that already have a reel, across a month end", () => {
  const now = new Date("2026-11-29T10:00:00Z");
  const taken = [new Date("2026-11-29T14:00:00Z"), new Date("2026-11-30T14:00:00Z")];
  assert.equal(nextSlot(now, IST, taken).toISOString(), "2026-12-01T14:00:00.000Z");
});

test("nextSlot: a taken day blocks the slot even if the taken post is at another time", () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const taken = [parseLocalDateTime("2026-11-08T09:00", "Asia/Kolkata")];
  assert.equal(nextSlot(now, IST, taken).toISOString(), "2026-11-09T14:00:00.000Z");
});

test("decideDue: wait before, publish within the window, late after it", () => {
  const slot = new Date("2026-11-08T14:00:00Z");
  assert.equal(decideDue(slot, new Date("2026-11-08T13:59:00Z"), 3), "wait");
  assert.equal(decideDue(slot, new Date("2026-11-08T14:00:00Z"), 3), "publish");
  assert.equal(decideDue(slot, new Date("2026-11-08T16:59:00Z"), 3), "publish");
  assert.equal(decideDue(slot, new Date("2026-11-08T17:01:00Z"), 3), "late");
});

test("parseLocalDateTime reads wall time in the zone and rejects junk", () => {
  assert.equal(parseLocalDateTime("2026-11-08T21:00", "Asia/Kolkata").toISOString(), "2026-11-08T15:30:00.000Z");
  assert.throws(() => parseLocalDateTime("tomorrow 9pm", "Asia/Kolkata"));
  const p = localParts(new Date("2026-11-08T15:30:00Z"), "Asia/Kolkata");
  assert.deepEqual([p.hour, p.minute], [21, 0]);
});
