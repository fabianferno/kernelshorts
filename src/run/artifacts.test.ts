import test from "node:test";
import assert from "node:assert/strict";
import { contentTypeFor, resolveRange } from "./artifacts.js";

test("mp4/wav/json/png/jpg all sniff to the right content type", () => {
  assert.equal(contentTypeFor("/runs/2026-08-12/exports/master.mp4"), "video/mp4");
  assert.equal(contentTypeFor("/runs/2026-08-12/vo/hook.wav"), "audio/wav");
  assert.equal(contentTypeFor("/runs/2026-08-12/script.json"), "application/json");
  assert.equal(contentTypeFor("frame.png"), "image/png");
  assert.equal(contentTypeFor("thumb.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("thumb.jpeg"), "image/jpeg");
});

test("extension sniffing is case-insensitive and falls back to octet-stream", () => {
  assert.equal(contentTypeFor("MASTER.MP4"), "video/mp4");
  assert.equal(contentTypeFor("checkpoint-dir"), "application/octet-stream");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
});

test("no range serves the whole artifact", () => {
  assert.deepEqual(resolveRange(100), { start: 0, end: 99, length: 100 });
});

test("an open-ended range (the browser's first <video> probe) is not zero bytes", () => {
  assert.deepEqual(resolveRange(100, { start: 0 }), { start: 0, end: 99, length: 100 });
  assert.deepEqual(resolveRange(100, { start: 40 }), { start: 40, end: 99, length: 60 });
});

test("range ends are inclusive on both sides", () => {
  assert.deepEqual(resolveRange(100, { start: 0, end: 0 }), { start: 0, end: 0, length: 1 });
  assert.deepEqual(resolveRange(100, { start: 10, end: 19 }), { start: 10, end: 19, length: 10 });
});

test("a range past the end is clamped, not an error — Safari asks for bytes=0-1023 on short files", () => {
  assert.deepEqual(resolveRange(500, { start: 0, end: 1023 }), {
    start: 0,
    end: 499,
    length: 500,
  });
});

test("a start past the end is rejected (416, not an empty 206)", () => {
  assert.throws(() => resolveRange(100, { start: 100 }), RangeError);
  assert.throws(() => resolveRange(100, { start: 500, end: 600 }), RangeError);
});

test("an inverted range is rejected", () => {
  assert.throws(() => resolveRange(100, { start: 50, end: 10 }), RangeError);
});
