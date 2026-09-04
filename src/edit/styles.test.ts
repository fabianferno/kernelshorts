import test from "node:test";
import assert from "node:assert/strict";
import { splitLines, needsScrim, variantForIndex, titleHtml, compositionCss } from "./styles.js";

test("titles wrap at the configured words per line", () => {
  assert.deepEqual(splitLines("one two three four five", 3), ["one two three", "four five"]);
});

test("a forced treatment of none never asks for a scrim", () => {
  assert.equal(needsScrim(0, "none"), false);
});

test("a boxed treatment needs no scrim; a bare one does", () => {
  assert.equal(needsScrim(0, "boxLight"), false);
  assert.equal(needsScrim(0, "hardShadow"), true);
});

test("the variant cycles across beats so one short does not repeat a look", () => {
  const treatments = [0, 1, 2, 3].map((i) => variantForIndex(i).treatment);
  const fonts = [0, 1, 2, 3].map((i) => variantForIndex(i).font);
  assert.ok(new Set(treatments).size > 1, "expected treatments to vary");
  assert.ok(new Set(fonts).size > 1, "expected fonts to vary");
});

test("the cycle wraps", () => {
  assert.deepEqual(variantForIndex(4), variantForIndex(0));
});

test("a forced treatment overrides the treatment but not the font", () => {
  assert.equal(variantForIndex(1, "boxDark").treatment, "boxDark");
  assert.equal(variantForIndex(1, "boxDark").font, variantForIndex(1).font);
});

test("a beat with no title renders no element at all", () => {
  assert.equal(
    titleHtml({ beatId: "hook", text: undefined, startS: 0, durationS: 2,
                variant: { font: "coolvetica", treatment: "boxLight" } }),
    "",
  );
  assert.equal(
    titleHtml({ beatId: "hook", text: "X", startS: 0, durationS: 2,
                variant: { font: "coolvetica", treatment: "none" } }),
    "",
  );
});

test("a title carries its timing in seconds and is marked as a clip", () => {
  const html = titleHtml({
    beatId: "hook", text: "HELLO", startS: 1.5, durationS: 2.25,
    variant: { font: "coolvetica", treatment: "boxLight" },
  });
  assert.match(html, /data-start="1\.5"/);
  assert.match(html, /data-duration="2\.25"/);
  assert.match(html, /class="[^"]*clip/);
  assert.match(html, /id="title-hook"/);
  assert.match(html, /HELLO/);
});

test("title text is HTML-escaped so a script never reaches the composition", () => {
  const html = titleHtml({
    beatId: "x", text: "<script>alert(1)</script>", startS: 0, durationS: 1,
    variant: { font: "coolvetica", treatment: "boxLight" },
  });
  assert.ok(!html.includes("<script>"), "raw script tag leaked into the composition");
  assert.match(html, /&lt;script&gt;/);
});

test("the composition CSS sizes the root box in explicit pixels", () => {
  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });
  assert.match(css, /width:\s*1080px/);
  assert.match(css, /height:\s*1920px/);
  // Untimed full-bleed elements need their own positioning or they collapse.
  assert.match(css, /\.clip\s*\{[^}]*position:\s*absolute/);
});

test("the scrim is opaque at the top and gone by mid-frame", () => {
  // Reproduces scrim.ts's ffmpeg matte, alpha 255 * max(0, 1 - Y/(H/2)):
  // opaque black at the TOP, fully transparent by MID-frame. Titles are
  // centred at 24% of frame height — well inside that ramp. An inverted
  // gradient adds nothing behind the title and dims the caption band at 72%,
  // which captions never asked for (they carry their own 3px black stroke).
  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });
  const scrim = css.slice(css.indexOf(".scrim"), css.indexOf(".title {"));
  const gradient = scrim.slice(scrim.indexOf("linear-gradient"), scrim.indexOf(");") + 1);
  const stops = [...gradient.matchAll(/rgba\(0,\s*0,\s*0,\s*([\d.]+)\)\s*(\d+)%/g)].map(
    ([, alpha, pos]) => ({ alpha: Number(alpha), pos: Number(pos) }),
  );
  assert.match(gradient, /to bottom/);
  assert.equal(stops.length, 2, `expected two colour stops, got: ${gradient}`);
  assert.deepEqual(stops[0], { alpha: 1, pos: 0 }, "must start fully opaque at the top");
  assert.deepEqual(stops[1], { alpha: 0, pos: 50 }, "must be fully transparent by mid-frame");
});

test("per-font line-height is an additive gap, never a raw negative length", () => {
  const css = compositionCss({ width: 1080, height: 1920, fontFaces: "" });
  assert.ok(!/line-height:\s*-\d/.test(css), "negative px line-height is invalid CSS and is dropped by browsers");
  // Calibrated to Palmier (PALMIER_SCALE): -14/2/-18 in Palmier's reference
  // space, scaled 1.8x to land on the canvas at the size Palmier rendered.
  assert.match(css, /line-height:\s*calc\(1em \+ -25px\)/); // coolvetica
  assert.match(css, /line-height:\s*calc\(1em \+ 4px\)/); // herkey
  assert.match(css, /line-height:\s*calc\(1em \+ -32px\)/); // melodrame
});
