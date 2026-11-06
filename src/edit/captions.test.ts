import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, type WordTiming } from "./captions.js";

const timings: WordTiming[] = [
  { word: "hacker", startS: 0.0, endS: 0.4 },
  { word: "news", startS: 0.4, endS: 0.9 },
];

test("words come from the script, timings come from the transcriber", () => {
  // The transcriber misheard "Hacker News" as "hacker noose" — the script wins.
  const heard: WordTiming[] = [
    { word: "hacker", startS: 0.0, endS: 0.4 },
    { word: "noose", startS: 0.4, endS: 0.9 },
  ];
  const aligned = alignWords("Hacker News", heard, 1);
  assert.deepEqual(aligned.map((w) => w.word), ["Hacker", "News"]);
  assert.deepEqual(aligned.map((w) => w.startS), [0.0, 0.4]);
});

test("a transcriber that returns fewer words than the script still covers every word", () => {
  const aligned = alignWords("one two three four", timings, 2);
  assert.equal(aligned.length, 4);
  // Every word has a non-zero window and they are monotonic.
  for (let i = 0; i < aligned.length; i++) {
    assert.ok(aligned[i]!.endS > aligned[i]!.startS, `word ${i} has an empty window`);
    if (i > 0) assert.ok(aligned[i]!.startS >= aligned[i - 1]!.startS);
  }
  // The last word ends no later than the measured VO duration.
  assert.ok(aligned.at(-1)!.endS <= 2 + 1e-9);
});

test("no timings at all distributes words across the measured duration", () => {
  const aligned = alignWords("one two three four", [], 2);
  assert.equal(aligned.length, 4);
  assert.equal(aligned[0]!.startS, 0);
  assert.ok(Math.abs(aligned.at(-1)!.endS - 2) < 1e-6);
});
