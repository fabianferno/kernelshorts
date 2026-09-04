import test from "node:test";
import assert from "node:assert/strict";
import { alignWords, captionsHtml, type WordTiming } from "./captions.js";
import { compositionCss } from "./styles.js";

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

test("caption timings are rebased onto the beat's global start", () => {
  // Beat starts at frame 60 = 2s, so a word at 0.4s local is 2.4s global.
  const html = captionsHtml({ beatId: "hook", startFrame: 60, words: timings });
  assert.match(html, /data-start="2"/);
  assert.match(html, /data-start="2\.4"/);
});

test("each caption word is its own timed clip with an id", () => {
  const html = captionsHtml({ beatId: "hook", startFrame: 0, words: timings });
  assert.match(html, /id="cap-hook-0"/);
  assert.match(html, /id="cap-hook-1"/);
  assert.match(html, /hacker/);
  assert.match(html, /news/);
});

test("caption words are HTML-escaped", () => {
  const html = captionsHtml({
    beatId: "x", startFrame: 0,
    words: [{ word: "<b>", startS: 0, endS: 1 }],
  });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;b&gt;/);
});

test("words group into lines of at most 5, and a line's window spans its first word's start to its last word's end", () => {
  const words: WordTiming[] = [
    { word: "one", startS: 0, endS: 0.2 },
    { word: "two", startS: 0.2, endS: 0.4 },
    { word: "three", startS: 0.4, endS: 0.6 },
    { word: "four", startS: 0.6, endS: 0.8 },
    { word: "five", startS: 0.8, endS: 1.0 },
    { word: "six", startS: 1.0, endS: 1.2 },
    { word: "seven", startS: 1.2, endS: 1.4 },
  ];
  const html = captionsHtml({ beatId: "b", startFrame: 0, words });
  const lineMatches = [...html.matchAll(/class="clip caption-line"[^>]*data-start="([^"]+)"\s+data-duration="([^"]+)"/g)];
  assert.equal(lineMatches.length, 2, "expected two lines for 7 words at maxWords 5");
  // First line: words 0..4 (one..five), spans 0 to 1.0.
  assert.equal(lineMatches[0]![1], "0");
  assert.equal(Number(lineMatches[0]![2]), 1.0);
  // Second line: words 5..6 (six, seven), spans 1.0 to 1.4.
  assert.equal(Number(lineMatches[1]![1]), 1.0);
  assert.ok(Math.abs(Number(lineMatches[1]![2]) - 0.4) < 1e-9);
});

test("every class emitted by captionsHtml has a matching rule in compositionCss", () => {
  const html = captionsHtml({
    beatId: "b",
    startFrame: 0,
    words: timings,
    highlight: "pop",
  });
  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });

  const classAttrs = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(classAttrs.length > 0, "expected captionsHtml to emit at least one class attribute");
  const classNames = new Set(classAttrs.flatMap((c) => c.split(/\s+/)));
  for (const className of classNames) {
    assert.match(
      css,
      new RegExp(`\\.${className.replace(/[[\]/{}()*+?.\\^$|]/g, "\\$&")}\\s*[,{]`),
      `no CSS rule for emitted class "${className}"`,
    );
  }
});

test("both highlight modes emit their tuned color", () => {
  const block = captionsHtml({ beatId: "b", startFrame: 0, words: timings, highlight: "block" });
  const pop = captionsHtml({ beatId: "b", startFrame: 0, words: timings, highlight: "pop" });
  assert.match(block, /caption-word__hl--block/);
  assert.match(pop, /caption-word__hl--pop/);

  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });
  assert.match(css, /\.caption-word__hl--block\s*\{[^}]*#E11D2E/);
  assert.match(css, /\.caption-word__hl--pop\s*\{[^}]*#FDE047/);
});

test("a line remains visible while its individual words' highlight windows advance", () => {
  const html = captionsHtml({ beatId: "hook", startFrame: 0, words: timings });
  const lineMatch = html.match(/class="clip caption-line"[^>]*data-start="([^"]+)"\s+data-duration="([^"]+)"/);
  assert.ok(lineMatch, "expected a caption-line clip");
  const lineStart = Number(lineMatch![1]);
  const lineEnd = lineStart + Number(lineMatch![2]);

  const hlMatches = [...html.matchAll(/class="caption-word__hl caption-word__hl--\w+"\s+data-start="([^"]+)"\s+data-duration="([^"]+)"/g)];
  assert.equal(hlMatches.length, 2);
  for (const [, start, duration] of hlMatches) {
    const hlStart = Number(start);
    const hlEnd = hlStart + Number(duration);
    // Every word's highlight window falls entirely inside the line's window,
    // so the line (and every other word in it) stays on screen the whole
    // time any one word is highlighted.
    assert.ok(hlStart >= lineStart, "word highlight starts before its line");
    assert.ok(hlEnd <= lineEnd + 1e-9, "word highlight outlasts its line");
  }
});
