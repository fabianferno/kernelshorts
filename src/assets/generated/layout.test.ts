import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { GeneratedScene } from "../../shared/schemas.js";
import { buildPage } from "./page.js";
import { SAFE } from "./theme.js";

/**
 * Layout and timing contracts for the generated scenes.
 *
 * WHY THIS FILE EXISTS. verifyGeneratedClip() looks at the finished mp4:
 * resolution, fps, duration, not-black, frames-differ. Every one of those
 * passed on three shipped defects that a human found by eye in a finished edit:
 *
 *  1. the diagram scene grew its band upward to fit five nodes and collided
 *     with the overlay title (a solid box centred at y=460 on the timeline —
 *     see edit/text-styles.ts, centerY 0.24). Correct in isolation, ruined in
 *     the cut.
 *  2. the metric scene revealed its label only after the count finished, so
 *     most of a 3.6s beat showed a bare number with nothing to say what it was.
 *  3. a clip came back short under render contention (covered separately, in
 *     concurrency.test.ts).
 *
 * A file-level check cannot see composition. This one measures the real page in
 * a real Chromium at 1080x1920, at chosen instants, via window.__renderAt.
 *
 * No video is encoded: the page is the thing under test, and rendering three
 * dozen clips to answer a geometry question would put the suite in minutes.
 */

const W = 1080;

/** Sub-pixel slack. The stage carries a 1.5% settle scale for the first ~1.2s
 *  and text bounding boxes are antialiased; 1px keeps that from reading as a
 *  band violation while staying far below anything a viewer could see. */
const EPS = 1;

interface Measured {
  id: string;
  tag: string;
  text: string;
  rect: { left: number; top: number; right: number; bottom: number };
  opacity: number;
  focal: boolean;
  progressive: boolean;
  hasText: boolean;
  clipX: number;
  clipY: number;
}

/**
 * Collects every element that carries something a viewer must READ or SEE as
 * content — text of its own, or a painted box (an HTML background, or an SVG
 * rect, which is how the diagram draws its nodes).
 *
 * Anything under [data-decor] is skipped: the glows, grid, caption scrim and
 * particle canvas are meant to bleed past the safe band. Making that an
 * explicit marker rather than an id list means a new decorative layer opts
 * itself out at the point it is added, and a new CONTENT layer is covered by
 * default — the safe direction to fail.
 */
const MEASURE = `() => {
  const skip = new Set(['SCRIPT','STYLE','HEAD','META','HTML','BODY','TITLE']);
  const out = [];
  const grow = (box, r) => {
    if (r.width === 0 || r.height === 0) return box;
    if (!box) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    return { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top),
             right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) };
  };
  // Text is measured by its GLYPH RUNS, not its block box. A centred label in a
  // full-width div has a block box the width of the band, so the block box says
  // nothing about whether the words are inside the margins — and the metric
  // number's block box is 920px wide for two digits.
  const ink = (el) => {
    const range = document.createRange();
    let box = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) box = grow(box, r);
    }
    return box;
  };
  for (const el of document.querySelectorAll('*')) {
    if (skip.has(el.tagName.toUpperCase())) continue;
    if (el.closest('[data-decor]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const own = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const tag = el.tagName.toLowerCase();
    const bg = cs.backgroundColor || '';
    const painted = tag === 'rect' ||
      (bg !== '' && bg !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(bg));
    if (!own && !painted) continue;
    const r = painted ? grow(null, el.getBoundingClientRect()) : ink(el);
    if (!r) continue;
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const o = parseFloat(getComputedStyle(n).opacity);
      if (!Number.isNaN(o)) op *= o;
    }
    // Only a container that actually CLIPS can hide anything. An element with
    // overflow:visible reports a scroll delta whenever its line box is taller
    // than its content box (a 230px number on line-height:1 does), and nothing
    // is hidden — flagging that would be noise.
    const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const canScroll = clips && typeof el.scrollWidth === 'number' && el.clientWidth > 0;
    out.push({
      id: el.id || (el.className && el.className.baseVal === undefined ? String(el.className) : tag),
      tag,
      text: (own || el.textContent || '').trim().slice(0, 48),
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      opacity: op,
      focal: !!el.closest('[data-focal]'),
      progressive: !!el.closest('[data-reveal="progressive"]'),
      hasText: own.length > 0,
      clipX: canScroll ? el.scrollWidth - el.clientWidth : 0,
      clipY: canScroll ? el.scrollHeight - el.clientHeight : 0,
    });
  }
  return out;
}`;

interface Timing {
  T: number;
  body0: number;
  body1: number;
}

let browser: Browser;

before(async () => {
  browser = await chromium.launch({
    // Same flags renderScene uses: without SwiftShader the particles scene's
    // WebGLRenderer throws on a headless Mac and the whole page never readies.
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-lcd-text",
      "--force-color-profile=srgb",
    ],
  });
}, { timeout: 120_000 });

after(async () => {
  await browser?.close();
});

/** Loads a scene page and returns a sampler that renders at an exact t. */
async function open(spec: GeneratedScene, durationS: number) {
  const html = await buildPage(spec, durationS);
  const page = await browser.newPage({
    viewport: { width: W, height: 1920 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForFunction("window.__sceneReady === true", null, { timeout: 20_000 });
  await page.evaluate("document.fonts.ready");
  const timing = (await page.evaluate("window.__timing")) as Timing;
  return {
    timing,
    async at(t: number): Promise<Measured[]> {
      await page.evaluate(`window.__renderAt(${t})`);
      const err = await page.evaluate("window.__sceneError || null");
      if (err) throw new Error(`scene threw in-page at t=${t}: ${err}`);
      return (await page.evaluate(`(${MEASURE})()`)) as Measured[];
    },
    async close() {
      await page.close();
      if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
    },
  };
}

const where = (m: Measured) =>
  `<${m.tag} ${m.id}> "${m.text}" ` +
  `[${m.rect.left.toFixed(0)},${m.rect.top.toFixed(0)} → ` +
  `${m.rect.right.toFixed(0)},${m.rect.bottom.toFixed(0)}]`;

/** The six scenes, plus the three stress shapes that broke earlier renders. */
const CASES: Array<{ name: string; spec: unknown }> = [
  {
    name: "code",
    spec: {
      scene: "code",
      language: "javascript",
      code: 'const socket = new WebSocket("wss://app.dev/live");\nsocket.onmessage = (e) => render(e.data);',
      highlightLines: [2],
    },
  },
  {
    name: "code/long-line",
    // 90+ columns: no font size in the ladder fits it, so it MUST wrap — and
    // the wrapped result still has to fit the card. This is the shape whose
    // last line was cut off in the first render.
    spec: {
      scene: "code",
      language: "typescript",
      code:
        'export async function subscribeToLiveDocumentUpdates(connection: SocketConnection, documentId: string) {\n' +
        '  connection.on("patch", (patch) => applyPatchToDom(document.body, patch));\n' +
        "}",
    },
  },
  {
    name: "terminal",
    spec: {
      scene: "terminal",
      lines: [{ command: "npm run bench", output: "ok  1.2s\n12,400 req/s" }],
    },
  },
  {
    name: "terminal/8-steps",
    spec: {
      scene: "terminal",
      lines: [
        { command: "git clone https://github.com/acme/live" },
        { command: "cd live && npm i", output: "added 214 packages" },
        { command: "npm run build", output: "built in 1.4s" },
        { command: "npm test", output: "42 passing" },
        { command: "npm run bench", output: "12,400 req/s" },
        { command: "docker build -t live .", output: "sha256:9f3c" },
        { command: "docker run -p 80:80 live", output: "listening on :80" },
        { command: "curl -s localhost/health", output: "ok" },
      ],
    },
  },
  {
    name: "diagram",
    spec: {
      scene: "diagram",
      nodes: [
        { id: "b", label: "Browser" },
        { id: "s", label: "Server" },
      ],
      edges: [{ from: "b", to: "s", direction: "both", label: "HTML frames" }],
    },
  },
  {
    name: "diagram/5-nodes",
    // Five nodes is the schema maximum and the exact shape that grew the band
    // upward into the overlay title.
    spec: {
      scene: "diagram",
      nodes: [
        { id: "b", label: "Browser" },
        { id: "e", label: "Edge Proxy" },
        { id: "a", label: "App Server" },
        { id: "q", label: "Queue" },
        { id: "d", label: "Database" },
      ],
      edges: [
        { from: "b", to: "e", direction: "both", label: "WebSocket" },
        { from: "e", to: "a", label: "HTTP" },
        { from: "a", to: "q", label: "jobs" },
        { from: "q", to: "d", label: "writes" },
      ],
    },
  },
  { name: "metric", spec: { scene: "metric", value: "10", label: "lines of client JavaScript", sublabel: "no framework" } },
  {
    name: "compare",
    spec: {
      scene: "compare",
      left: { title: "Before", items: ["300KB of client JS", "hydration on every load", "state in two places"] },
      right: { title: "After", items: ["server renders HTML", "socket pushes patches", "one source of truth"] },
    },
  },
  { name: "particles", spec: { scene: "particles", mood: "network" } },
];

/** 3.2s is the short beat where both timing defects surfaced; 6s and 9s cover
 *  the long end, where a scene can instead finish early and sit frozen. */
const DURATIONS = [3.2, 6, 9];

for (const c of CASES) {
  for (const durationS of DURATIONS) {
    test(`${c.name} @ ${durationS}s obeys the layout and timing contracts`, { timeout: 120_000 }, async () => {
      const spec = GeneratedScene.parse(c.spec);
      const s = await open(spec, durationS);
      try {
        const fractions = [0.25, 0.45, 0.5, 0.75, 0.95];
        const samples = new Map<number, Measured[]>();
        for (const f of fractions) samples.set(f, await s.at(durationS * f));
        const atBody1 = await s.at(s.timing.body1);

        // ── Contract 1: everything readable sits inside the safe band ──
        // Derived from SAFE, never hardcoded: widen the band and the test
        // follows. Above it is the overlay title, below it the caption band.
        for (const [f, els] of samples) {
          for (const m of els) {
            const t = (durationS * f).toFixed(2);
            assert.ok(
              m.rect.top >= SAFE.contentTop - EPS,
              `t=${t}s: ${where(m)} rises above the title band (contentTop ${SAFE.contentTop})`,
            );
            assert.ok(
              m.rect.bottom <= SAFE.contentBottom + EPS,
              `t=${t}s: ${where(m)} drops into the caption band (contentBottom ${SAFE.contentBottom})`,
            );
            assert.ok(
              m.rect.left >= SAFE.margin - EPS,
              `t=${t}s: ${where(m)} breaks the left margin (${SAFE.margin})`,
            );
            assert.ok(
              m.rect.right <= W - SAFE.margin + EPS,
              `t=${t}s: ${where(m)} breaks the right margin (${W - SAFE.margin})`,
            );
          }
        }

        // ── Contract 2: nothing is clipped ──
        // A container that has to scroll to show its content is showing a cut
        // -off last line in a video that cannot scroll.
        for (const [f, els] of samples) {
          for (const m of els) {
            const t = (durationS * f).toFixed(2);
            assert.ok(m.clipX <= 1, `t=${t}s: ${where(m)} is clipped horizontally by ${m.clipX}px`);
            assert.ok(m.clipY <= 1, `t=${t}s: ${where(m)} is clipped vertically by ${m.clipY}px`);
          }
        }

        // ── Contract 3: context arrives early ──
        // Two exemptions, both deliberate:
        //  * [data-focal] — the metric's counting number. It is SUPPOSED to be
        //    mid-animation; it is the reveal, not the context.
        //  * [data-reveal=progressive] — typing, terminal output, staggered
        //    bullets, the diagram building itself. Unfolding over the beat is
        //    the whole point of those scenes.
        // What is left is the framing: labels, column titles, window chrome.
        // That text must be up by 45% of the clip, because a viewer who reads
        // the focal value and finds no caption for it has already scrolled.
        const at45 = samples.get(0.45)!;
        for (const m of at45) {
          if (!m.hasText || m.focal || m.progressive) continue;
          assert.ok(
            m.opacity >= 0.9,
            `${where(m)} is still at opacity ${m.opacity.toFixed(2)} at 45% of a ` +
              `${durationS}s clip — context has to land with the reveal, not after it`,
          );
        }

        // ── Contract 3b: and everything else is up by the end of the body ──
        // The tail exists to HOLD the finished state. Anything still fading in
        // at BODY1 finishes during the hold, or never.
        for (const m of atBody1) {
          if (!m.hasText || m.focal) continue;
          assert.ok(
            m.opacity >= 0.9,
            `${where(m)} is only at opacity ${m.opacity.toFixed(2)} at BODY1 ` +
              `(${s.timing.body1.toFixed(2)}s of ${durationS}s) — it arrives during the tail hold`,
          );
        }
      } finally {
        await s.close();
      }
    });
  }
}
