import test from "node:test";
import assert from "node:assert/strict";
import {
  PublishMetadata,
  validateMetadata,
  containsUrl,
  missingAttribution,
  hnItemUrl,
} from "./metadata.js";
import type { ScriptJSON } from "../shared/schemas.js";

const HN = "https://news.ycombinator.com/item?id=49275335";
const ART = "https://en.andros.dev/blog/ef4968f5/html-over-websockets/";
const URLS = [HN, ART];

function meta(p: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "HTML over WebSockets: real-time SPAs with barely any JavaScript",
    description: `Rendering moves to the server and only HTML fragments travel.\n\n${HN}\n${ART}`,
    hashtags: ["#websockets", "#html", "#liveview"],
    instagram_caption: `No loading screens, barely any JS.\n\n${HN}\n${ART}\n\n#websockets #html`,
    ...p,
  };
}

// ─── title cap ──────────────────────────────────────────────────────────────

test("a title at exactly 100 characters is accepted", () => {
  const title = "a".repeat(100);
  const res = validateMetadata(meta({ title }), URLS);
  assert.equal(res.ok, true);
});

test("a 101-character title is rejected with its real length, not truncated", () => {
  const res = validateMetadata(meta({ title: "b".repeat(101) }), URLS);
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /title is 101 characters — the limit is 100/);
  assert.match(res.errors.join(" "), /do not cut it off mid-word/);
});

// ─── hashtags ───────────────────────────────────────────────────────────────

test("a hashtag without a leading # is rejected", () => {
  const res = validateMetadata(meta({ hashtags: ["websockets", "#html", "#go"] }), URLS);
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /hashtags\.0.*start with "#"/);
});

test("a hashtag containing a space is rejected", () => {
  const res = validateMetadata(meta({ hashtags: ["#web sockets", "#html", "#go"] }), URLS);
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /must not contain spaces/);
});

test("engagement-bait hashtags are rejected in code, not just in the prompt", () => {
  for (const bait of ["#viral", "#FYP", "#shorts"]) {
    const res = validateMetadata(meta({ hashtags: [bait, "#html", "#go"] }), URLS);
    assert.equal(res.ok, false, `${bait} should be rejected`);
  }
});

test("hashtags differing only in case count as duplicates", () => {
  const res = validateMetadata(
    meta({ hashtags: ["#WebSockets", "#websockets", "#html"] }),
    URLS,
  );
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /duplicate hashtags: #websockets/);
});

test("more than 8 hashtags is rejected", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `#tag${i}`);
  const res = validateMetadata(meta({ hashtags: nine }), URLS);
  assert.equal(res.ok, false);
});

// ─── attribution ────────────────────────────────────────────────────────────

test("a description missing the article link is rejected and names the link", () => {
  const res = validateMetadata(
    meta({ description: `Nice article about websockets.\n\n${HN}` }),
    URLS,
  );
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /description must end with the source links/);
  assert.match(res.errors.join(" "), /andros\.dev/);
});

test("an instagram caption missing both links is rejected", () => {
  const res = validateMetadata(
    meta({
      instagram_caption:
        "Cool tech that moves rendering to the server side.\n\n#websockets #html",
    }),
    URLS,
  );
  assert.equal(res.ok, false);
  assert.ok(!res.ok);
  assert.match(res.errors.join(" "), /instagram_caption must include the source links/);
});

test("a trailing slash or different case does not count as a missing link", () => {
  assert.equal(containsUrl(`see ${ART.replace(/\/$/, "")}`, ART), true);
  assert.equal(containsUrl(`SEE ${ART.toUpperCase()}`, ART), true);
  assert.deepEqual(missingAttribution(`${HN} ${ART}`, URLS), []);
  assert.deepEqual(missingAttribution(HN, URLS), [ART]);
});

// ─── hn item url ────────────────────────────────────────────────────────────

function script(topic: ScriptJSON["topic"]): ScriptJSON {
  return {
    run_id: "t",
    topic,
    target_duration_s: 45,
    music_mood: "upbeat-tech",
    beats: [],
    claims: [],
    cta: { vo_text: "x", on_screen_text: "x" },
  } as unknown as ScriptJSON;
}

test("the HN item url is derived from the topic's hn id, and omitted without one", () => {
  assert.equal(hnItemUrl(script({ hn_id: 49275335, title: "t", url: ART })), HN);
  assert.equal(hnItemUrl(script({ title: "t", url: ART })), undefined);
});

// ─── schema ─────────────────────────────────────────────────────────────────

test("a fully valid object round-trips through the schema", () => {
  const parsed = PublishMetadata.parse(meta());
  assert.equal(parsed.hashtags.length, 3);
  assert.ok(parsed.description.endsWith(ART));
});
