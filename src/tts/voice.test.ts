import test from "node:test";
import assert from "node:assert/strict";
import { wordsFromTokens, parseVoiceOverride, VoiceSpec } from "./voice.js";

test("Soniox tokens group into words: a leading space starts a new word", () => {
  const words = wordsFromTokens([
    { text: "Did", start_ms: 270, end_ms: 380 },
    { text: " cry", start_ms: 1470, end_ms: 1600 },
    { text: "stal", start_ms: 1600, end_ms: 1880 },
    { text: " ", start_ms: 1880, end_ms: 1890 },
    { text: " Rolex", start_ms: 2970, end_ms: 3300 },
    { text: "?", start_ms: 3300, end_ms: 3350 },
    { text: " untimed" },
  ]);
  assert.deepEqual(words.map((w) => w.word), ["Did", "crystal", "Rolex?"]);
  assert.equal(words[1]!.startS, 1.47);
  assert.equal(words[1]!.endS, 1.88);
});

test("--voice overrides: provider:id switches provider, a bare id keeps it", () => {
  const base = VoiceSpec.parse({ provider: "elevenlabs", voiceId: "abc", label: "x" });
  assert.deepEqual(parseVoiceOverride("sarvam:priya", base), { provider: "sarvam", voiceId: "priya" });
  assert.deepEqual(parseVoiceOverride("def", base), { provider: "elevenlabs", voiceId: "def", label: undefined });
  assert.equal(parseVoiceOverride(undefined, base), base);
});

test("an unknown provider is rejected in character.json", () => {
  assert.throws(() => VoiceSpec.parse({ provider: "polly", voiceId: "x" }));
});
