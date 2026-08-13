import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractReadable } from "./fetch-source.js";

const FIXTURE = `<!doctype html>
<html><head>
  <title>Fixture &mdash; Example</title>
  <meta property="og:title" content="The Real Title">
  <style>.a { color: red }</style>
  <script>var x = "SHOULD NOT APPEAR";</script>
</head>
<body>
  <header><a href="/home">Home</a><a href="/about">About</a>NAVJUNK</header>
  <nav><ul><li>MENUJUNK</li></ul></nav>
  <main>
    <h1>Widget 3.2 ships</h1>
    <p>The parser handles <b>1,000,000</b> rows per second&nbsp;on a laptop.</p>
    <p>It was first released in 2014 &amp; has been maintained since.</p>
    <blockquote>Node<i></i>.js support landed in 3.1.</blockquote>
    <p>See the <a href="/docs/perf">benchmarks</a> and <a href="https://other.example/x">the writeup</a>.</p>
  </main>
  <aside>SIDEBARJUNK</aside>
  <footer>FOOTERJUNK</footer>
</body></html>`;

const BASE = "https://example.com/blog/post";

test("script, style, nav, header, footer and aside text never reaches the output", () => {
  const { text } = extractReadable(FIXTURE, BASE);
  for (const junk of ["SHOULD NOT APPEAR", "NAVJUNK", "MENUJUNK", "SIDEBARJUNK", "FOOTERJUNK", "color: red"]) {
    assert.ok(!text.includes(junk), `leaked: ${junk}`);
  }
});

test("og:title wins over <title>", () => {
  assert.equal(extractReadable(FIXTURE, BASE).title, "The Real Title");
});

test("falls back to <title> with entities decoded when there is no og:title", () => {
  const html = FIXTURE.replace(/<meta property="og:title"[^>]*>/, "");
  assert.equal(extractReadable(html, BASE).title, "Fixture — Example");
});

test("prose survives verbatim so the fact-checker can substring-match an excerpt", () => {
  const { text } = extractReadable(FIXTURE, BASE);
  // This is the whole contract of the module: an excerpt copied from what the
  // model was shown must be findable with an exact string search.
  assert.ok(text.includes("The parser handles 1,000,000 rows per second on a laptop."));
  assert.ok(text.includes("It was first released in 2014 & has been maintained since."));
});

test("inline tags do not inject spaces mid-token", () => {
  // <b>1,000,000</b> and Node<i></i>.js would become "1,000,000 rows" / "Node .js"
  // under a naive tag->space replacement, silently breaking every quote.
  const { text } = extractReadable(FIXTURE, BASE);
  assert.ok(text.includes("Node.js support landed in 3.1."));
  assert.ok(!text.includes("Node .js"));
});

test("block boundaries become paragraph breaks", () => {
  const { text } = extractReadable(FIXTURE, BASE);
  assert.ok(text.includes("Widget 3.2 ships\n\nThe parser handles"));
});

test("whitespace inside a paragraph is collapsed to single spaces", () => {
  const { text } = extractReadable("<p>a   b\n\t c</p>", BASE);
  assert.equal(text, "a b c");
});

test("links are absolutised, deduped and kept in document order", () => {
  const { links } = extractReadable(FIXTURE, BASE);
  assert.deepEqual(links, [
    "https://example.com/home",
    "https://example.com/about",
    "https://example.com/docs/perf",
    "https://other.example/x",
  ]);
});

test("javascript: and fragment hrefs are dropped", () => {
  const { links } = extractReadable(
    `<a href="#top">t</a><a href="javascript:void(0)">j</a><a href="/ok">o</a>`,
    BASE,
  );
  assert.deepEqual(links, ["https://example.com/ok"]);
});

test("numeric, hex and named entities decode; nbsp becomes a plain space", () => {
  assert.equal(decodeEntities("&#65;&#x42;&amp;&nbsp;&rsquo;"), "AB& ’");
});

test("an unknown entity is left alone rather than silently deleted", () => {
  assert.equal(decodeEntities("&notarealentity; x"), "&notarealentity; x");
});

test("an unclosed script tag does not leak its contents", () => {
  const { text } = extractReadable("<p>keep</p><script>var leakme=1;", BASE);
  assert.ok(text.includes("keep"));
  assert.ok(!text.includes("leakme"));
});

test("html comments are stripped", () => {
  const { text } = extractReadable("<p>keep</p><!-- COMMENTJUNK -->", BASE);
  assert.equal(text, "keep");
});
