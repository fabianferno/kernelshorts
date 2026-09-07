import test from "node:test";
import assert from "node:assert/strict";
import { mergeToScriptWords } from "./transcribe.js";

/** Shorthand for a whisper token; the leading space mirrors the real server. */
const t = (word: string, start: number, end: number) => ({ word, start, end });

/**
 * The exact tokens the live server returned for the `hook` beat of run
 * 2026-08-18, which is what exposed the defect: 19 tokens for 14 script words.
 */
const HOOK_TOKENS = [
  t(" Imagine", 0.25, 0.46), t(" a", 0.46, 0.52), t(" database", 0.52, 1.05),
  t(" that", 1.05, 1.31), t("'s", 1.31, 1.44), t(" 40", 1.62, 1.83),
  t(" times", 1.83, 2.12), t(" faster", 2.24, 2.6), t(" with", 2.6, 2.93),
  t(" a", 3.03, 3.03), t(" single", 3.03, 3.4), t(" query", 3.4, 3.9),
  t(".", 3.9, 3.9), t(" That", 4.1, 4.3), t("'s", 4.3, 4.4),
  t(" what", 4.4, 4.6), t("'s", 4.6, 4.7), t(" new", 4.7, 5.0), t(".", 5.0, 5.0),
];
const HOOK_TEXT = "Imagine a database that's 40 times faster with a single query. That's what's new.";

test("the real hook beat: 19 whisper tokens fold onto 14 script words", () => {
  const merged = mergeToScriptWords(HOOK_TEXT.split(/\s+/), HOOK_TOKENS);
  assert.equal(merged.length, 14);
  assert.deepEqual(merged.map((w) => w.word), HOOK_TEXT.split(/\s+/));
});

test("a contraction absorbs its split tokens and spans both their windows", () => {
  const merged = mergeToScriptWords(HOOK_TEXT.split(/\s+/), HOOK_TOKENS);
  const thats = merged[3]!;
  assert.equal(thats.word, "that's");
  // " that" starts at 1.05, "'s" ends at 1.44 — the merged window covers both.
  assert.equal(thats.startS, 1.05);
  assert.equal(thats.endS, 1.44);
});

test("without merging, every word after the first contraction is mistimed", () => {
  // This is the regression this module exists to prevent. Positional pairing
  // against the RAW tokens gives script word 4 ("40") the timing of "'s".
  const scriptWords = HOOK_TEXT.split(/\s+/);
  const raw = HOOK_TOKENS[4]!;
  assert.equal(raw.word, "'s");
  const merged = mergeToScriptWords(scriptWords, HOOK_TOKENS);
  assert.equal(scriptWords[4], "40");
  assert.notEqual(merged[4]!.startS, raw.start);
  // The merged timing is whisper's actual window for "40", not the token beside it.
  assert.equal(merged[4]!.startS, 1.62);
});

test("bare punctuation tokens are dropped rather than consuming a script word", () => {
  const merged = mergeToScriptWords(
    ["hello", "world"],
    [t(" hello", 0, 0.4), t(".", 0.4, 0.4), t(" world", 0.5, 0.9)],
  );
  assert.deepEqual(merged, [
    { word: "hello", startS: 0, endS: 0.4 },
    { word: "world", startS: 0.5, endS: 0.9 },
  ]);
});

test("the script supplies the words even when whisper mishears one", () => {
  // Whisper hears "noose" where the script says "News". The script wins, and
  // the mishearing costs only its own word — the next word stays aligned.
  const merged = mergeToScriptWords(
    ["Hacker", "News", "today"],
    [t(" Hacker", 0, 0.4), t(" noose", 0.4, 0.9), t(" today", 0.9, 1.3)],
  );
  assert.deepEqual(merged.map((w) => w.word), ["Hacker", "News", "today"]);
  assert.equal(merged[1]!.startS, 0.4);
  assert.equal(merged[2]!.startS, 0.9, "drift must not propagate past the mishearing");
});

test("windows are monotonic and non-empty across the whole real beat", () => {
  const merged = mergeToScriptWords(HOOK_TEXT.split(/\s+/), HOOK_TOKENS);
  for (let i = 0; i < merged.length; i++) {
    assert.ok(merged[i]!.endS >= merged[i]!.startS, `word ${i} has an inverted window`);
    if (i > 0) {
      assert.ok(merged[i]!.startS >= merged[i - 1]!.startS, `word ${i} steps backwards`);
    }
  }
});

test("fewer tokens than words returns fewer timings rather than guessing", () => {
  // alignWords spreads the remaining words across the measured duration; that
  // is its job, not this module's. Inventing timings here would be a fabrication.
  const merged = mergeToScriptWords(
    ["one", "two", "three", "four"],
    [t(" one", 0, 0.3), t(" two", 0.3, 0.6)],
  );
  assert.equal(merged.length, 2);
});

test("more tokens than words never overruns the script", () => {
  const merged = mergeToScriptWords(
    ["one"],
    [t(" one", 0, 0.3), t(" two", 0.3, 0.6), t(" three", 0.6, 0.9)],
  );
  assert.equal(merged.length, 1);
});

test("no tokens at all yields no timings, not a crash", () => {
  assert.deepEqual(mergeToScriptWords(["one", "two"], []), []);
});

test("case and punctuation differences do not block a match", () => {
  const merged = mergeToScriptWords(
    ["Imagine", "a", "database."],
    [t(" imagine", 0, 0.4), t(" a", 0.4, 0.5), t(" Database", 0.5, 1.0)],
  );
  assert.deepEqual(merged.map((w) => w.word), ["Imagine", "a", "database."]);
  assert.equal(merged[2]!.endS, 1.0);
});

test("a hyphenated script word absorbs the pieces whisper splits it into", () => {
  const merged = mergeToScriptWords(
    ["open-source", "tooling"],
    [t(" open", 0, 0.3), t("-", 0.3, 0.3), t("source", 0.3, 0.7), t(" tooling", 0.7, 1.2)],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.startS, 0);
  assert.equal(merged[0]!.endS, 0.7);
  assert.equal(merged[1]!.startS, 0.7);
});

/**
 * The exact tokens the live server returned for the `what_is` beat of run
 * 2026-08-18 — 18 tokens for 11 script words, and the case that forced the
 * greedy merge to be replaced with alignment. Whisper hears "DuckDB" as three
 * unrelated tokens, splits "2.0", and renders "Cyanoptera" as three syllables.
 */
const WHAT_IS_TOKENS = [
  t(" The", 0.04, 0.04), t(" only", 0.11, 0.41), t(" V", 0.41, 0.5),
  t(" version", 0.5, 1.11), t(" 2", 1.2, 1.42), t(".", 1.51, 1.7), t("0", 1.7, 1.84),
  t(" is", 1.95, 2.25), t(" named", 2.49, 2.87),
  t(" Sin", 2.87, 3.24), t("op", 3.24, 3.48), t("tera", 3.48, 3.69),
  t(" after", 4.3, 4.62), t(" a", 4.62, 4.66), t(" type", 4.89, 5.23),
  t(" of", 5.28, 5.38), t(" duck", 5.52, 5.82), t(".", 5.93, 6.0),
];
const WHAT_IS_TEXT = 'DuckDB version 2.0 is named "Cyanoptera" after a type of duck.';

test("a badly misheard word does not desync the rest of the beat", () => {
  const words = WHAT_IS_TEXT.split(/\s+/);
  const merged = mergeToScriptWords(words, WHAT_IS_TOKENS);
  assert.equal(merged.length, words.length);

  // The anchors after the mishearing must land on their own audio. Greedy
  // merging put these ~3 tokens early; "duck." ended at 3.69s in a 6.4s clip.
  const at = (w: string) => merged[words.indexOf(w)]!;
  assert.equal(at("version").startS, 0.5);
  assert.equal(at("is").startS, 1.95);
  assert.equal(at("after").startS, 4.3);
  assert.equal(at("duck.").endS, 5.82);
});

test("a word split into syllables spans all of them", () => {
  const words = WHAT_IS_TEXT.split(/\s+/);
  const merged = mergeToScriptWords(words, WHAT_IS_TOKENS);
  // "Cyanoptera" is heard as Sin+op+tera: 2.87 through 3.69.
  const cyan = merged[words.indexOf('"Cyanoptera"')]!;
  assert.equal(cyan.startS, 2.87);
  assert.equal(cyan.endS, 3.69);
  // "2.0" is heard as 2 + . + 0: 1.2 through 1.84.
  const twoOh = merged[words.indexOf("2.0")]!;
  assert.equal(twoOh.startS, 1.2);
  assert.equal(twoOh.endS, 1.84);
});

test("captions still reach the end of the audio when a word is misheard", () => {
  // The regression in one number: the last caption word must not finish
  // 2.7s early, which is what left the tail of this beat uncaptioned.
  const words = WHAT_IS_TEXT.split(/\s+/);
  const merged = mergeToScriptWords(words, WHAT_IS_TOKENS);
  assert.ok(merged.at(-1)!.endS > 5.5, `last word ended at ${merged.at(-1)!.endS}s, expected past 5.5s`);
});
