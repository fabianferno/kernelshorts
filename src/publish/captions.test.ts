import test from "node:test";
import assert from "node:assert/strict";
import { PostCaptions, captionProblems } from "./captions.js";

test("a normal pair of captions has no problems", () => {
  const c = PostCaptions.parse({
    instagram: { caption: "a recruiter said hi. six months later, $6.3B was gone.\n\n#cybersecurity #devlife #northkorea" },
    youtube: { title: "The $6.3B job interview", description: "Source: The Register", tags: ["binance", "cyber security"] },
  });
  assert.deepEqual(captionProblems(c), []);
});

test("platform limits are all reported at once", () => {
  const c = PostCaptions.parse({
    instagram: { caption: "x".repeat(2190) + Array.from({ length: 31 }, (_, i) => ` #t${i}`).join("") },
    youtube: { title: "<b>" + "y".repeat(100), description: "a > b", tags: ["z".repeat(501)] },
  });
  const p = captionProblems(c);
  assert.ok(p.some((s) => s.startsWith("instagram caption is")));
  assert.ok(p.some((s) => s.includes("31 hashtags")));
  assert.ok(p.some((s) => s.startsWith("youtube title is")));
  assert.ok(p.includes("youtube title contains < or >"));
  assert.ok(p.includes("youtube description contains < or >"));
  assert.ok(p.some((s) => s.startsWith("youtube tags total")));
});

test("empty captions are rejected", () => {
  assert.deepEqual(captionProblems(PostCaptions.parse({})), ["captions name neither instagram nor youtube"]);
});
