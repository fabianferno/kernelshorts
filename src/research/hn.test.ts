import test from "node:test";
import assert from "node:assert/strict";
import {
  filterStories,
  flattenComments,
  normalizeUrl,
  stripHtml,
  MIN_POINTS,
  type HnStory,
} from "./hn.js";

function story(p: Partial<HnStory>): HnStory {
  return {
    id: 1,
    title: "A neat developer tool",
    url: "https://example.com/tool",
    points: 500,
    num_comments: 100,
    author: "someone",
    created_at: "2026-08-13T00:00:00Z",
    hn_url: "https://news.ycombinator.com/item?id=1",
    ...p,
  };
}

// ─── filterStories ──────────────────────────────────────────────────────────

test("a front-page tool story survives every filter", () => {
  const { kept, dropped } = filterStories([story({})]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test("a story below the point threshold is dropped with its score in the reason", () => {
  const { kept, dropped } = filterStories([story({ points: MIN_POINTS - 1 })]);
  assert.equal(kept.length, 0);
  assert.match(dropped[0]!.reason, /below 100 points \(99\)/);
});

test("a text post with no url is dropped as not demonstrable", () => {
  const { dropped } = filterStories([story({ url: null, title: "Ask HN: how do you test?" })]);
  assert.match(dropped[0]!.reason, /no external url/);
});

test("a paywalled domain is dropped and the reason names the domain", () => {
  const { dropped } = filterStories([story({ url: "https://www.wsj.com/articles/x" })]);
  assert.match(dropped[0]!.reason, /paywalled domain: wsj\.com/);
});

test("a paywalled subdomain is dropped too", () => {
  const { dropped } = filterStories([story({ url: "https://blogs.wsj.com/x" })]);
  assert.match(dropped[0]!.reason, /paywalled domain/);
});

test("a domain that merely ends in a paywalled name is not dropped", () => {
  // notwsj.com must not match wsj.com — suffix matching needs the dot.
  const { kept } = filterStories([story({ url: "https://notwsj.com/x" })]);
  assert.equal(kept.length, 1);
});

test("a political headline is dropped and the reason names the keyword", () => {
  const { dropped } = filterStories([
    story({ title: "Trump signs order on chip exports" }),
  ]);
  assert.match(dropped[0]!.reason, /political keyword in title: "trump"/);
});

test("political matching is case-insensitive", () => {
  const { kept } = filterStories([story({ title: "The 2026 ELECTION data pipeline" })]);
  assert.equal(kept.length, 0);
});

test("every dropped story carries a reason — nothing vanishes", () => {
  const input = [
    story({ id: 1, points: 10 }),
    story({ id: 2, url: null }),
    story({ id: 3, url: "https://ft.com/a" }),
    story({ id: 4, title: "Senate hearing on AI" }),
    story({ id: 5 }),
  ];
  const { kept, dropped } = filterStories(input);
  assert.equal(kept.length + dropped.length, input.length);
  for (const d of dropped) assert.ok(d.reason.length > 0);
});

test("an unparseable url is dropped rather than crashing the filter", () => {
  const { dropped } = filterStories([story({ url: "not a url" })]);
  assert.match(dropped[0]!.reason, /unparseable url/);
});

// ─── normalizeUrl ───────────────────────────────────────────────────────────

test("protocol, www, trailing slash and query all normalize away", () => {
  const canonical = "example.com/blog/post";
  for (const u of [
    "https://example.com/blog/post",
    "http://example.com/blog/post",
    "https://www.example.com/blog/post/",
    "https://example.com/blog/post?utm_source=hn",
    "https://example.com/blog/post#section",
  ]) {
    assert.equal(normalizeUrl(u), canonical, u);
  }
});

test("different paths on the same host stay distinct", () => {
  assert.notEqual(normalizeUrl("https://example.com/a"), normalizeUrl("https://example.com/b"));
});

test("host case is normalized", () => {
  assert.equal(normalizeUrl("https://EXAMPLE.com/A"), "example.com/A");
});

// ─── stripHtml ──────────────────────────────────────────────────────────────

test("tags are removed and entities decoded", () => {
  assert.equal(
    stripHtml("<p>He said &quot;a &amp; b&quot; &lt;fast&gt;</p>"),
    'He said "a & b" <fast>',
  );
});

test("anchor text survives while the tag is removed", () => {
  assert.equal(
    stripHtml('see <a href="https://x.com/y" rel="nofollow">this post</a>'),
    "see this post",
  );
});

test("numeric entities decode — HN escapes every url slash as &#x2F;", () => {
  assert.equal(stripHtml("https:&#x2F;&#x2F;a.com&#x2F;b &#39;q&#39;"), "https://a.com/b 'q'");
});

test("paragraph breaks become blank lines, br becomes a newline", () => {
  assert.equal(stripHtml("one<p>two<br>three"), "one\n\ntwo\nthree");
});

// ─── flattenComments ────────────────────────────────────────────────────────

test("the tree is flattened breadth-first with correct depths", () => {
  const flat = flattenComments({
    children: [
      { id: 1, author: "a", text: "top one", children: [{ id: 3, author: "c", text: "reply" }] },
      { id: 2, author: "b", text: "top two" },
    ],
  });
  assert.deepEqual(
    flat.map((c) => [c.id, c.depth]),
    [[1, 1], [2, 1], [3, 2]],
  );
});

test("sibling order is preserved — it is HN's own ranking", () => {
  const flat = flattenComments({
    children: [
      { id: 10, text: "first" },
      { id: 11, text: "second" },
      { id: 12, text: "third" },
    ],
  });
  assert.deepEqual(flat.map((c) => c.id), [10, 11, 12]);
});

test("comments deeper than 3 are dropped but their subtree is still walked past", () => {
  let node: Record<string, unknown> = { id: 100, text: "deep", children: [] };
  const deepest = node;
  for (let d = 4; d >= 1; d--) node = { id: d, text: `d${d}`, children: [node] };
  void deepest;
  const flat = flattenComments({ children: [node] });
  assert.deepEqual(flat.map((c) => c.depth), [1, 2, 3]);
});

test("deleted comments (no text) are skipped, their replies are not", () => {
  const flat = flattenComments({
    children: [{ id: 1, children: [{ id: 2, text: "still here" }] }],
  });
  assert.deepEqual(flat.map((c) => c.id), [2]);
});

test("comment text is stripped and truncated to 600 chars with an ellipsis", () => {
  const long = "x".repeat(900);
  const flat = flattenComments({ children: [{ id: 1, text: `<p>${long}</p>` }] });
  assert.equal(flat[0]!.text.length, 601);
  assert.ok(flat[0]!.text.endsWith("…"));
});

test("no more than 40 comments come back", () => {
  const children = Array.from({ length: 120 }, (_, i) => ({ id: i, text: `c${i}` }));
  assert.equal(flattenComments({ children }).length, 40);
});

test("a missing author is recorded as unknown rather than undefined", () => {
  const flat = flattenComments({ children: [{ id: 1, text: "hi" }] });
  assert.equal(flat[0]!.author, "unknown");
});
