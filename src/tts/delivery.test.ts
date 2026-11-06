import test from "node:test";
import assert from "node:assert/strict";
import { spokenText, textForProvider, deliveryWarnings, tagsIn } from "./delivery.js";

const line = "[excited] INCREDIBLE news! [pause] It was *never* the plan. [laughs] Really.";

test("captions see only the words: no tags, no stress asterisks", () => {
  assert.equal(spokenText(line), "INCREDIBLE news! It was never the plan. Really.");
});

test("Soniox gets the markup verbatim", () => {
  assert.equal(textForProvider(line, "soniox"), line);
});

test("Sarvam and ElevenLabs get punctuation instead of tags — nothing to read aloud", () => {
  const el = textForProvider(line, "elevenlabs");
  assert.ok(!/[[\]*]/.test(el), el);
  assert.match(el, /news!/);
  assert.ok(!/laughs|excited|pause/i.test(el), el);
  // Sarvam also softens long ALL-CAPS (it may spell them) but keeps acronyms
  const sv = textForProvider("[serious] AI made this INCREDIBLE.", "sarvam");
  assert.equal(sv, "AI made this Incredible.");
  // [pause]/[long pause] become pause punctuation
  assert.equal(textForProvider("Wait [pause] what", "elevenlabs"), "Wait, what");
  assert.equal(textForProvider("a ROLEX? [pause] It's *true*.", "sarvam"), "a Rolex? It's true.");
  assert.equal(textForProvider("Wait [long pause] what", "sarvam"), "Wait… what");
});

test("unknown and over-stacked tags are flagged; documented ones pass", () => {
  assert.deepEqual(deliveryWarnings("[excited] [warm] Hello"), []);
  assert.match(deliveryWarnings("[laughs and screams] no")[0]!, /unknown tag/);
  assert.ok(deliveryWarnings("[happy] [warm] [softly] hi").some((w) => /stacked/.test(w)));
  assert.deepEqual(tagsIn(line), ["excited", "pause", "laughs"]);
});
