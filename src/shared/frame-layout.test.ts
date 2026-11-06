import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPTION, CAPTION_BOTTOM, CHROME, COUNTER, FOOTNOTE_TOP, PLATFORM_SAFE, STAGE_CARD, TAG, propBand } from "./frame-layout.js";
import { studioCss } from "../edit/studio.js";

test("a two-line caption ends above where any prop may start", () => {
  assert.ok(CAPTION_BOTTOM >= CAPTION.top + 2 * CAPTION.fontSize * CAPTION.lineHeight - 1);
  for (const counter of [false, true]) for (const tag of [false, true]) {
    const b = propBand({ counter, tag });
    assert.ok(b.top > CAPTION_BOTTOM, `band top ${b.top} under captions (counter ${counter}, tag ${tag})`);
    assert.ok(b.bottom < FOOTNOTE_TOP);
    assert.ok(b.bottom - b.top >= 400, "band too thin for a hero prop");
  }
});

test("counter and tag stack below the captions in order", () => {
  assert.ok(COUNTER.top >= CAPTION_BOTTOM);
  assert.ok(TAG.topWithCounter >= COUNTER.bottom);
  assert.ok(propBand({ counter: true, tag: true }).top > TAG.topWithCounter + TAG.height);
});

test("the compositor draws captions and footnote where the layout says", () => {
  const css = studioCss("");
  assert.match(css, new RegExp(`\\.cap \\{[^}]*top: ${CAPTION.top}px`));
  assert.match(css, new RegExp(`\\.footnote \\{[^}]*top: ${FOOTNOTE_TOP}px`));
});

test("nothing readable sits under the platform's header or in the side crop", () => {
  assert.ok(CHROME.top >= PLATFORM_SAFE.top, "chrome under the Reels tabs");
  assert.ok(CAPTION.top >= CHROME.top + CHROME.height, "captions overlap the chrome");
  assert.ok(CHROME.side >= PLATFORM_SAFE.side, "brand/badge in the side crop");
  assert.ok(STAGE_CARD.top > CAPTION_BOTTOM && STAGE_CARD.bottom < FOOTNOTE_TOP);
});
