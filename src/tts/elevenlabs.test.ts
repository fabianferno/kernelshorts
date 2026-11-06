import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsFromAlignment, wordsSidecarPath } from "./elevenlabs.js";

function align(text: string, step = 0.1) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * step),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * step),
  };
}

test("groups characters into words with first-start / last-end timing", () => {
  const words = wordsFromAlignment(align("Did you know"));
  assert.deepEqual(
    words.map((w) => w.word),
    ["Did", "you", "know"],
  );
  assert.equal(words[0]!.startS, 0);
  assert.ok(Math.abs(words[0]!.endS - 0.3) < 1e-9);
  assert.ok(Math.abs(words[1]!.startS - 0.4) < 1e-9);
  assert.ok(Math.abs(words[2]!.endS - 1.2) < 1e-9);
});

test("collapses repeated whitespace and keeps punctuation on the word", () => {
  const words = wordsFromAlignment(align("  Wait,  really?  "));
  assert.deepEqual(
    words.map((w) => w.word),
    ["Wait,", "really?"],
  );
});

test("empty alignment yields no words", () => {
  assert.deepEqual(wordsFromAlignment(align("")), []);
});

test("sidecar path swaps the extension", () => {
  assert.equal(wordsSidecarPath("/x/vo/hook.wav"), "/x/vo/hook.words.json");
});
