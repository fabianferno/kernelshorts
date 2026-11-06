import { test } from "node:test";
import assert from "node:assert/strict";
import { GeneratedScene } from "../../shared/schemas.js";
import { buildPage, inlineThree } from "./page.js";

/** Page building is pure — these run without a browser or ffmpeg. */

test("every scene builds a self-contained page with no remote references", async () => {
  const specs: unknown[] = [
    { scene: "code", language: "go", code: "func main() {\n\tprintln(\"hi\")\n}", highlightLines: [2] },
    { scene: "terminal", lines: [{ command: "go test ./...", output: "ok  0.4s" }] },
    {
      scene: "diagram",
      nodes: [{ id: "a", label: "Client" }, { id: "b", label: "Server" }],
      edges: [{ from: "a", to: "b", direction: "both", label: "frames" }],
    },
    { scene: "metric", value: "1,200", label: "requests/sec" },
    { scene: "compare", left: { title: "Before", items: ["slow"] }, right: { title: "After", items: ["fast"] } },
    { scene: "particles", mood: "data" },
  ];
  for (const raw of specs) {
    const html = await buildPage(GeneratedScene.parse(raw), 5);
    assert.match(html, /window\.__start/);
    assert.match(html, /function render/);
    // No network at render time (PRD §4a): no tag may load a remote resource.
    // (Bare URLs in three.js source comments are inert and don't count.)
    assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:/);
    // Fonts are embedded, never fetched: every @font-face src is a data: URL.
    assert.match(html, /@font-face \{ font-family: "Timeless Sans"/);
    assert.match(html, /@font-face \{ font-family: "Inter"/);
    assert.doesNotMatch(html, /src:\s*url\((?!data:)/);
  }
});

test("a diagram edge naming an unknown node fails at build time", async () => {
  const spec = GeneratedScene.parse({
    scene: "diagram",
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "zzz" }],
  });
  await assert.rejects(() => buildPage(spec, 5), /unknown node ids/);
});

test("code sizing never leaves a line wrapped when it can avoid it", async () => {
  const spec = GeneratedScene.parse({
    scene: "code",
    language: "javascript",
    code: 'const socket = new WebSocket("wss://example.com/live-updates");\nsocket.onmessage = render;',
  });
  const html = await buildPage(spec, 6);
  const fs = Number(html.match(/--fs:(\d+)px/)![1]);
  // 63 chars must fit the 830px inner width at ~0.62em per glyph.
  assert.ok(fs * 0.62 * 63 <= 830, `font-size ${fs}px would wrap the longest line`);
});

test("three.js inlines as one self-contained classic script", async () => {
  const src = await inlineThree();
  assert.ok(src.length > 1_000_000);
  assert.match(src, /window\.THREE=/);
  // A leftover import/require would mean a fetch at render time.
  assert.doesNotMatch(src, /\brequire\(['"]\./);
  assert.doesNotMatch(src, /\bfrom\s*['"]\.\//);
});
