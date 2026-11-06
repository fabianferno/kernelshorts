import test from "node:test";
import assert from "node:assert/strict";
import {
  themesForBeats,
  scheduleHost,
  mouthIntervals,
  captionGroups,
  emphasisMask,
  captionsStudioHtml,
  chromeHtml,
  hostLayer,
  type GlobalWord,
  type StudioBeat,
} from "./studio.js";
import { HOLD_MAX_S, HOLD_MIN_S } from "../host/poses.js";

function words(text: string, startS = 0, step = 0.3): GlobalWord[] {
  return text.split(" ").map((w, i) => ({
    word: w,
    startS: startS + i * step,
    endS: startS + i * step + step * 0.8,
    index: i,
  }));
}

test("themes: hook is dark, every chapter change flips", () => {
  assert.deepEqual(
    themesForBeats([{}, { chapter: "A" }, { chapter: "A" }, { chapter: "B" }, { chapter: "C" }]),
    ["dark", "light", "light", "dark", "light"],
  );
});

test("host: trigger words switch pose, respecting the minimum hold", () => {
  const all = new Set(["talk", "talk-2", "idle", "point-up", "two", "shrug"]);
  const w = words("so first we look at the second reason why it fails", 0, 0.3);
  const segs = scheduleHost(w, 5, all);
  const poses = segs.map((s) => s.pose);
  assert.ok(poses.includes("point-up"), `expected point-up in ${poses}`);
  assert.ok(poses.includes("two"), `expected two in ${poses}`);
  for (const s of segs.slice(0, -1)) {
    assert.ok(s.endS - s.startS >= HOLD_MIN_S - 1e-9, `segment ${s.pose} shorter than HOLD_MIN_S`);
  }
  // contiguous, starts at 0, ends at total
  assert.equal(segs[0]!.startS, 0);
  assert.equal(segs.at(-1)!.endS, 5);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i]!.startS, segs[i - 1]!.endS);
});

test("host: with no triggers it still moves within HOLD_MAX_S", () => {
  const all = new Set(["talk", "talk-2", "idle"]);
  const w = words(Array(40).fill("blah").join(" "), 0, 0.3); // 12 s of untriggered speech
  const segs = scheduleHost(w, 12, all);
  assert.ok(segs.length >= 3, `only ${segs.length} segments in 12 s`);
  for (const s of segs.slice(0, -1)) {
    assert.ok(s.endS - s.startS <= HOLD_MAX_S + 0.35, `${s.pose} held ${s.endS - s.startS}s`);
  }
});

test("host: only available poses are scheduled", () => {
  const segs = scheduleHost(words("first second third"), 2, new Set(["talk"]));
  assert.deepEqual([...new Set(segs.map((s) => s.pose))], ["talk"]);
});

test("mouth: open intervals stay inside their word and never overlap", () => {
  const ivs = mouthIntervals([
    { word: "a", startS: 0, endS: 0.1 },
    { word: "longword", startS: 0.5, endS: 1.1 },
  ]);
  assert.ok(ivs.length >= 3);
  for (const iv of ivs) assert.ok(iv.endS > iv.startS);
  for (let i = 1; i < ivs.length; i++) assert.ok(ivs[i]!.startS >= ivs[i - 1]!.endS);
  assert.ok(!ivs.some((iv) => iv.startS >= 0.1 && iv.endS <= 0.5), "mouth open in the gap");
});

test("emphasis: phrases match across punctuation and case", () => {
  assert.deepEqual(
    emphasisMask(["About", "400", "watts.", "Today"], ["400 watts"]),
    [false, true, true, false],
  );
});

test("captions: ≤3 words, break on punctuation, groups tile without gaps", () => {
  const w = [
    { word: "Did", startS: 0, endS: 0.2 },
    { word: "you", startS: 0.2, endS: 0.35 },
    { word: "know?", startS: 0.35, endS: 0.6 },
    { word: "Microsoft", startS: 0.8, endS: 1.3 },
    { word: "carved", startS: 1.3, endS: 1.6 },
    { word: "tiny", startS: 1.6, endS: 1.8 },
    { word: "rivers", startS: 1.8, endS: 2.2 },
  ];
  const g = captionGroups(w, ["Microsoft"], 2.6);
  assert.deepEqual(g.map((x) => x.words.map((y) => y.word).join(" ")), [
    "Did you know?",
    "Microsoft carved tiny",
    "rivers",
  ]);
  assert.equal(g[1]!.words[0]!.em, true);
  for (let i = 1; i < g.length; i++) assert.equal(g[i - 1]!.endS, g[i]!.startS);
  assert.ok(g.at(-1)!.endS >= 2.5);
});

const beat = (over: Partial<StudioBeat> = {}): StudioBeat => ({
  beatId: "b1",
  startS: 10,
  durationS: 3,
  theme: "light",
  chapter: "THE CATCH",
  emphasis: ["rivers"],
  words: [
    { word: "tiny", startS: 0, endS: 0.4 },
    { word: "rivers", startS: 0.4, endS: 0.9 },
  ],
  ...over,
});

test("caption html: timed on the global clock, emphasis wrapped in a box", () => {
  const html = captionsStudioHtml(beat()).join("\n");
  assert.match(html, /class="clip cap cap--light"[^>]*data-start="10"/);
  assert.match(html, /<span class="clip cem" data-start="10.4"/);
  assert.ok(!html.includes("NaN"));
});

test("chrome: one clip per chapter run, progress dashes mark the current chapter", () => {
  const html = chromeHtml(
    [
      beat({ beatId: "a", startS: 0, chapter: undefined, theme: "dark" }),
      beat({ beatId: "b", startS: 3, chapter: "ONE" }),
      beat({ beatId: "c", startS: 6, chapter: "ONE" }),
      beat({ beatId: "d", startS: 9, chapter: "TWO", theme: "dark" }),
    ],
    "brand",
  );
  assert.equal(html.length, 2);
  assert.match(html[0]!, /data-start="3" data-duration="6"/);
  assert.match(html[1]!, /dash--done.*dash--now/);
});

test("host layer: flaps reference existing segments", () => {
  const segs = [
    { pose: "talk", startS: 0, endS: 2 },
    { pose: "shrug", startS: 2, endS: 4 },
  ];
  const { html, js } = hostLayer(segs, [{ startS: 2.5, endS: 2.6 }], () => "dark", (p, o) => `${p}${o ? "-open" : ""}.png`);
  assert.equal(html.length, 2); // one timed wrapper per pose segment
  assert.match(html[1]!, /id="hopen-1"/);
  assert.match(js, /\[\[1,2\.5,2\.6\]\]/);
});
