import test from "node:test";
import assert from "node:assert/strict";
import { baseCss, escapeHtml, CAPTION_FONT_SIZE } from "./styles.js";
import { studioCss } from "./studio.js";

test("baseCss fixes the canvas size and makes clips full-bleed by default", () => {
  const css = baseCss(1080, 1920);
  assert.match(css, /#root \{[^}]*width: 1080px; height: 1920px;[^}]*overflow: hidden/);
  assert.match(css, /\.clip \{ position: absolute; inset: 0; \}/);
});

test("escapeHtml neutralises markup from scripts", () => {
  assert.equal(escapeHtml(`<b>"x" & y</b>`), "&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;");
});

test("the caption size the review loop reports is the size the captions render at", () => {
  assert.match(studioCss(""), new RegExp(`\\.cap \\{[^}]*font-size: ${CAPTION_FONT_SIZE}px`));
});
