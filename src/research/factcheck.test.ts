import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carriesVerifiableDetail,
  groundExcerpt,
  groundClaims,
  normalizeForMatch,
} from "./factcheck.js";

/**
 * These are the lines that motivated the override, taken verbatim from the
 * first real M3 run, where the model marked every one of them "not_factual"
 * and the fact-checker let them through unsourced.
 */
const REAL_ESCAPED_LINES = [
  "A heat dome is high-pressure air trapping hot air, like a lid on a pot. It causes temperatures to stay high for days.",
  "These temperatures can be dangerous, especially for vulnerable people. The heat impacts infrastructure and can lead to drought.",
  "An upper-level ridge in the atmosphere is blocking cooler air, trapping heat underneath. This is especially true in low-lying areas.",
  "Some note temperature projections from models have historically overestimated temperatures in Europe. Others point out that drought conditions are also critical.",
];

test("carriesVerifiableDetail catches the lines the model waved through", () => {
  for (const line of REAL_ESCAPED_LINES) {
    assert.notEqual(
      carriesVerifiableDetail(line),
      null,
      `should have been caught as a factual assertion: ${line}`,
    );
  }
});

test("carriesVerifiableDetail lets genuinely non-assertive lines pass", () => {
  assert.equal(carriesVerifiableDetail("Ever wondered how that actually works?"), null);
  assert.equal(carriesVerifiableDetail("Let me show you what happened next."), null);
  assert.equal(
    carriesVerifiableDetail("Follow for daily HN finds"),
    null,
    "a call to action asserts nothing about the world",
  );
});

test("a number survives any framing, including a CTA or a question", () => {
  assert.notEqual(carriesVerifiableDetail("Follow for 3 new tools every day"), null);
  assert.notEqual(carriesVerifiableDetail("Did you know it shipped 4 years ago?"), null);
});

test("a plain declarative with no numbers or names is still an assertion", () => {
  // The line that broke the first two attempts at this check.
  assert.notEqual(
    carriesVerifiableDetail("The heat impacts infrastructure and can lead to drought."),
    null,
  );
  assert.notEqual(carriesVerifiableDetail("It ships with SQLite built in."), null);
});

test("one assertive sentence taints an otherwise rhetorical line", () => {
  const detail = carriesVerifiableDetail("Ever wondered why? It runs entirely in the browser.");
  assert.ok(detail?.includes("runs entirely"), detail ?? "expected the claim to be named");
});

test("groundExcerpt requires a real verbatim hit", () => {
  const source =
    "In total, we faced 19 separate instances of database corruption over six months.";
  assert.equal(groundExcerpt("we faced 19 separate instances", source).verbatim, true);
});

test("groundExcerpt survives smart quotes and rewrapped whitespace", () => {
  const source = "The team’s   fix landed\nin August.";
  const g = groundExcerpt("The team's fix landed in August.", source);
  assert.equal(g.verbatim, true, g.detail);
});

test("a paraphrase does not ground a claim", () => {
  const source = "We saw 19 separate instances of corruption over six months.";
  const g = groundExcerpt("There were nineteen corruption incidents in half a year.", source);
  assert.equal(g.verbatim, false);
});

test("a paraphrase is reported as a paraphrase, not as invention", () => {
  const source = "In total, we faced 19 separate instances of database corruption over six months.";
  const g = groundExcerpt("we faced 19 separate cases of database corruption over six months", source);
  assert.equal(g.verbatim, false);
  assert.ok(g.coverage > 0.8, `expected high word overlap, got ${g.coverage}`);
});

test("a claim citing an unfetched URL fails rather than passing unchecked", () => {
  const [claim] = groundClaims(
    [{ text: "x", source_url: "https://elsewhere.example/post", excerpt: "some quoted words here" }],
    [{ url: "https://fetched.example/post", text: "some quoted words here" }],
  );
  assert.equal(claim!.grounded, false);
  assert.match(claim!.detail, /not among the fetched sources/);
});

test("url matching ignores protocol, www, query and trailing slash", () => {
  const [claim] = groundClaims(
    [{ text: "x", source_url: "http://www.Example.com/post/?utm=1", excerpt: "some quoted words here" }],
    [{ url: "https://example.com/post", text: "and some quoted words here too" }],
  );
  assert.equal(claim!.grounded, true, claim!.detail);
});

test("an excerpt too short to be evidence is rejected", () => {
  const g = groundExcerpt("fast", "it is fast");
  assert.equal(g.verbatim, false);
  assert.match(g.detail, /too short/);
});

test("normalizeForMatch preserves words and digits", () => {
  assert.equal(normalizeForMatch("  The—Fix landed: 19 times.  "), "the-fix landed: 19 times.");
});
