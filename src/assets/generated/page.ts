import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { GeneratedScene } from "../../shared/schemas.js";
import { SAFE, THEME } from "./theme.js";

/**
 * Builds the single self-contained HTML document that Playwright records.
 *
 * Everything — CSS, JS, and three.js — is inlined. Nothing is fetched at render
 * time: a mid-capture network stall would show up as a frozen or half-drawn
 * frame in a finished video, and the render must work offline (PRD §4a).
 */

const require = createRequire(import.meta.url);

/**
 * three.cjs is the only three build that is self-contained: three.module.js
 * (and its .min sibling) `import ... from "./three.core.min.js"`, which cannot
 * be inlined as one script. The CJS bundle has ZERO require() calls, so a
 * two-line module shim turns it into a classic script exposing window.THREE.
 */
export async function inlineThree(): Promise<string> {
  // Resolved through the bare specifier: three's package.json "exports" map has
  // no "./build/*" entry, so a subpath require THROWS ERR_PACKAGE_PATH_NOT_
  // EXPORTED. Under CJS resolution the bare name lands on build/three.cjs.
  const path = require.resolve("three");
  if (!path.endsWith("three.cjs")) {
    throw new Error(
      `Expected the CommonJS three build, resolved ${path}. The ESM builds ` +
        `import ./three.core.js and cannot be inlined as one script.`,
    );
  }
  const src = await readFile(path, "utf8");
  return `window.THREE=(function(){const module={exports:{}};const exports=module.exports;\n${src}\nreturn module.exports;})();`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** JSON embedded in a <script> must not be able to close the tag. */
function json(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

// ─── shared runtime ─────────────────────────────────────────────────────────

/**
 * The one timing rule every scene obeys.
 *
 * `lead` and `tail` are breathing room; the scene's content animation fills the
 * `body` window in between. Content-driven durations (typing, line reveals) are
 * clamped to occupy at least 45% of the body, so a 3s beat is brisk-but-legible
 * and a 9s beat does not finish in second one and then sit frozen — the failure
 * freezedetect would catch and, worse, the viewer would feel.
 */
const RUNTIME_JS = `
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const seg = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a), 0, 1);
// easeOutCubic everywhere: motion decelerates into place, never overshoots.
// Bouncy easing next to real footage reads as a slideshow template.
const ease = (x) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x) => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;

const T = CFG.durationS;
const LEAD = Math.min(0.5, T * 0.15);
const TAIL = Math.min(1.0, T * 0.2);
const BODY0 = LEAD;
const BODY1 = Math.max(LEAD + 0.3, T - TAIL);
const BODYLEN = BODY1 - BODY0;
/** Content wants \`natural\` seconds; stretch it to fill the body if it is short.
 *  The 0.75 floor was set by watching real clips: at 0.45 a short terminal
 *  session finished 4s into a 7.2s beat and then sat blinking, which reads as a
 *  frozen clip even though it technically is not. */
function fill(natural) {
  return Math.min(BODYLEN, Math.max(BODYLEN * 0.75, natural));
}

const bgA = document.getElementById('bgA');
const bgB = document.getElementById('bgB');
const stage = document.getElementById('stage');

function ambient(t) {
  // Every frame must differ from the last (PRD §4a) and no 2s stretch may be
  // frozen, or freezedetect rejects the clip. Two counter-drifting glows give
  // continuous sub-pixel change even while a scene is holding its final state.
  const a = t * 0.16;
  bgA.style.transform = 'translate(' + (Math.sin(a) * 90).toFixed(2) + 'px,' + (Math.cos(a * 0.7) * 70).toFixed(2) + 'px)';
  bgB.style.transform = 'translate(' + (Math.cos(a * 0.9) * -80).toFixed(2) + 'px,' + (Math.sin(a * 0.6) * 60).toFixed(2) + 'px)';
  // Whole-stage settle: a 1.5% scale-in over the first beat of the clip.
  const s = 1 + 0.015 * (1 - ease(seg(t, 0, Math.min(1.2, T))));
  stage.style.transform = 'scale(' + s.toFixed(4) + ')';
  stage.style.opacity = seg(t, 0, 0.35).toFixed(3);
}

let t0 = null;
let done = false;
function loop(now) {
  if (t0 === null) t0 = now;
  const t = (now - t0) / 1000;
  const tc = Math.min(t, T);
  ambient(t);
  try { render(tc); } catch (e) { window.__sceneError = String(e && e.stack || e); throw e; }
  if (t >= T) done = true;
  requestAnimationFrame(loop);
}
/**
 * The clip is trimmed out of a longer recording, and the cut point is found by
 * running blackdetect on the raw webm (see render.ts): the page holds an opaque
 * WHITE pre-roll until __start() removes it, so the end of the first white
 * segment IS frame zero of the animation. White, not black: these scenes are
 * dark enough that a black pre-roll is indistinguishable from the scene itself
 * (measured — blackdetect merged the pre-roll and the first 4s of content into
 * one segment), whereas nothing in a scene is ever near-white full-frame.
 *
 * The cut is therefore measured from the recording itself rather than guessed
 * from wall-clock latency, which drifts by 100-400ms depending on how long
 * Chromium takes to flush its first frames.
 */
const pre = document.getElementById('preroll');
// The pre-roll PULSES between two near-white shades instead of sitting still.
// Playwright's recorder emits a frame only when the page changes, so a static
// white hold can produce zero captured frames (measured: the diagram scene's
// 800ms hold made it into the webm not at all) and the trim marker vanishes.
let pi = 0;
let prerollRaf = requestAnimationFrame(function pulse() {
  pre.style.background = (pi++ % 2) ? '#ffffff' : '#fbfbfb';
  prerollRaf = requestAnimationFrame(pulse);
});
window.__sceneReady = true;
window.__sceneDone = () => done;
window.__start = function () {
  cancelAnimationFrame(prerollRaf);
  pre.remove();
  requestAnimationFrame(loop);
};
`;

const BASE_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1080px; height:1920px; overflow:hidden; background:${THEME.bg}; }
body { font-family:${THEME.display}; color:${THEME.text}; -webkit-font-smoothing:antialiased; }
#bgA, #bgB { position:fixed; width:1600px; height:1600px; border-radius:50%; filter:blur(180px); will-change:transform; }
#bgA { left:-320px; top:120px; background:radial-gradient(circle, rgba(76,194,255,0.32), rgba(76,194,255,0) 70%); }
#bgB { left:180px; top:900px; background:radial-gradient(circle, rgba(225,29,46,0.26), rgba(225,29,46,0) 70%); }
#grid { position:fixed; inset:0;
  background-image:linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
                   linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size:90px 90px; mask-image:radial-gradient(ellipse at 50% 45%, #000 30%, transparent 75%); }
/* The caption band (centerY 0.72) is darkened so burned-in captions always win
   on contrast, whatever the scene draws underneath. */
#capband { position:fixed; left:0; right:0; top:1180px; height:740px;
  background:linear-gradient(to bottom, rgba(10,15,22,0) 0%, rgba(10,15,22,0.72) 26%, rgba(10,15,22,0.86) 100%); }
#stage { position:fixed; inset:0; transform-origin:50% 42%; will-change:transform,opacity; }
.panel { position:absolute; background:${THEME.panel}; border:2px solid ${THEME.panelEdge};
  border-radius:22px; box-shadow:0 40px 90px rgba(0,0,0,0.55); }
`;

// ─── per-scene markup + render() ────────────────────────────────────────────

interface Built {
  html: string;
  js: string;
  cfg: Record<string, unknown>;
  /** Set when the scene needs WebGL (three.js gets inlined only then). */
  three?: boolean;
}

/** Minimal, deliberately language-agnostic tokenizer.
 *  Highlighting exists to make code read as code on a phone at 34px — it is not
 *  a language service, and a wrong-but-plausible token colour costs nothing.
 *  Anything it cannot classify falls through as plain text rather than throwing. */
const KEYWORDS =
  "const let var function return if else for while class new import from export default async await " +
  "def fn pub struct impl match use mod type interface public private static void int string bool " +
  "package func go defer chan select case switch break continue try catch throw with yield lambda None True False null true false nil";

function tokenizeCode(code: string): Array<[string, string]> {
  const kw = new Set(KEYWORDS.split(" "));
  const out: Array<[string, string]> = [];
  let i = 0;
  const push = (cls: string, txt: string) => {
    if (txt) out.push([cls, txt]);
  };
  while (i < code.length) {
    const c = code[i]!;
    const rest = code.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^(\/\/|#)[^\n]*/))) {
      push("cm", m[0]); i += m[0].length; continue;
    }
    if ((m = rest.match(/^(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/))) {
      push("st", m[0]); i += m[0].length; continue;
    }
    if ((m = rest.match(/^\d[\d_.]*/))) { push("nu", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^[A-Za-z_$][\w$]*/))) {
      const word = m[0];
      const after = code.slice(i + word.length).match(/^\s*\(/);
      push(kw.has(word) ? "kw" : after ? "fn" : "id", word);
      i += word.length; continue;
    }
    if ((m = rest.match(/^[{}()[\];,.:=<>+\-*/&|!?%]+/))) {
      push("pn", m[0]); i += m[0].length; continue;
    }
    push("tx", c); i += 1;
  }
  return out;
}

function buildCode(spec: Extract<GeneratedScene, { scene: "code" }>): Built {
  // Character stream carries its own class so the typing animation can rebuild
  // the visible prefix each frame without re-tokenizing.
  const chars: Array<[string, string]> = [];
  let line = 1;
  for (const [cls, txt] of tokenizeCode(spec.code)) {
    for (const ch of txt) {
      chars.push([cls, ch]);
      if (ch === "\n") line += 1;
    }
  }
  const lineOfChar: number[] = [];
  let l = 1;
  for (const [, ch] of chars) {
    lineOfChar.push(l);
    if (ch === "\n") l += 1;
  }
  const lineCount = line;
  const lens = spec.code.split("\n").map((l) => l.length);
  // Fit by SIMULATED WRAP, not by line count. The first real render sized the
  // type from the line count alone and then wrapped anyway: `new WebSocket(
  // "wss://app.dev/liv` broke mid-token and pushed the last line off the card.
  // SF Mono advances ~0.601em per glyph; the card's inner width is 852px.
  // 830, not the card's full 852: at exactly 0.601em/glyph a 47-column line
  // fitted on paper and wrapped in the browser (the mono fallback resolves to
  // Menlo, which advances 0.6023em). The extra margin buys back the rounding.
  const INNER_W = 830;
  const AVAIL_H = SAFE.contentBottom - SAFE.contentTop - 124;
  const fitAt = (fs: number) => {
    const cols = Math.floor(INNER_W / (fs * 0.62));
    const r = lens.map((n) => Math.max(1, Math.ceil(n / cols)));
    return { rows: r, total: r.reduce((a, b) => a + b, 0) };
  };
  let fontSize = 34;
  let rowsPerLine: number[] = fitAt(34).rows;
  // First choice: the largest size at which NOTHING wraps and everything fits —
  // a wrapped code line reads as a typo. Only if even 19px wraps (a genuinely
  // long line) does wrapping win over illegibility.
  let chosen = false;
  for (let fs = 34; fs >= 19; fs--) {
    const f = fitAt(fs);
    if (f.total === lens.length && f.total * fs * 1.55 <= AVAIL_H) {
      fontSize = fs; rowsPerLine = f.rows; chosen = true; break;
    }
  }
  if (!chosen) {
    for (let fs = 34; fs >= 19; fs--) {
      const f = fitAt(fs);
      fontSize = fs; rowsPerLine = f.rows;
      if (f.total * fs * 1.55 <= AVAIL_H) break;
    }
  }
  const rows = rowsPerLine.reduce((a, b) => a + b, 0);
  const lineH = fontSize * 1.55;
  // Highlight bands are placed by WRAPPED row, so a highlighted line still
  // lines up when an earlier line wrapped.
  const rowOfLine: number[] = [];
  let acc = 0;
  for (const r of rowsPerLine) { rowOfLine.push(acc); acc += r; }
  const highlight = spec.highlightLines
    .filter((n) => n <= rowsPerLine.length)
    .map((n) => ({ row: rowOfLine[n - 1]!, rows: rowsPerLine[n - 1]! }));
  // The card hugs its content instead of leaving a dead slab underneath, and is
  // centred in the content band.
  // +0.4 row of slack: a clipped last line was the first render's worst look.
  const cardH = Math.round(Math.min(SAFE.contentBottom - SAFE.contentTop, 124 + (rows + 0.4) * lineH));
  const cardTop = Math.round(
    SAFE.contentTop + (SAFE.contentBottom - SAFE.contentTop - cardH) / 2,
  );

  return {
    cfg: { chars, lineOfChar, highlight, fontSize, lang: spec.language },
    html: `
<div class="panel" id="card" style="left:${SAFE.margin}px; right:${SAFE.margin}px; top:${cardTop}px; height:${Math.round(cardH)}px; overflow:hidden;">
  <div id="bar" style="height:64px; border-bottom:2px solid ${THEME.panelEdge}; display:flex; align-items:center; gap:14px; padding:0 26px;">
    <span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span>
    <span class="tab">${esc(spec.language)}</span>
  </div>
  <div id="hl"></div>
  <pre id="code"></pre>
</div>`,
    js: `
const codeEl = document.getElementById('code');
const hlEl = document.getElementById('hl');
const chars = CFG.chars, lineOf = CFG.lineOfChar;
const lineH = CFG.fontSize * 1.55;
const TYPE0 = BODY0;
const TYPE1 = BODY0 + fill(chars.length * 0.028);

function paint(n) {
  let html = '', cls = null, buf = '';
  for (let i = 0; i < n; i++) {
    const c = chars[i];
    if (c[0] !== cls) { if (buf) html += '<span class="' + cls + '">' + esc(buf) + '</span>'; cls = c[0]; buf = ''; }
    buf += c[1];
  }
  if (buf) html += '<span class="' + cls + '">' + esc(buf) + '</span>';
  codeEl.innerHTML = html + '<span id="cur"></span>';
}
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

let lastN = -1;
function render(t) {
  const n = Math.round(chars.length * ease(seg(t, TYPE0, TYPE1)));
  if (n !== lastN) { paint(n); lastN = n; }
  // Cursor blinks for the whole clip: motion continues after typing ends.
  const cur = document.getElementById('cur');
  if (cur) cur.style.opacity = (t >= TYPE1 && Math.floor(t * 2) % 2 === 0) ? 0.15 : 1;
  // Highlight bands slide in once their line has been typed, then hold.
  if (CFG.highlight.length && t > TYPE1 - 0.2) {
    const p = ease(seg(t, TYPE1 - 0.2, Math.min(T, TYPE1 + 0.7)));
    hlEl.innerHTML = CFG.highlight.map(function(h) {
      const top = 64 + 30 + h.row * lineH;
      return '<div style="position:absolute;left:0;right:0;top:' + top + 'px;height:' + (lineH * h.rows) +
        'px;background:rgba(225,29,46,' + (0.20 * p).toFixed(3) + ');border-left:' + (6 * p).toFixed(1) + 'px solid ${THEME.accent};"></div>';
    }).join('');
  }
}`,
  };
}

function buildTerminal(spec: Extract<GeneratedScene, { scene: "terminal" }>): Built {
  const steps: Array<{ kind: "command" | "output"; text: string }> = [];
  for (const l of spec.lines) {
    if (l.command) steps.push({ kind: "command", text: l.command });
    if (l.output) for (const o of l.output.split("\n")) steps.push({ kind: "output", text: o });
  }
  const totalChars = steps.reduce((n, s) => n + s.text.length, 0);
  // Output lines are wrapped by the browser, so budget height from the wrapped
  // count (~44 chars fit across the card at 31px SF Mono).
  const rows = steps.reduce((n, s) => n + Math.max(1, Math.ceil((s.text.length + 2) / 44)), 0);
  const cardH = Math.min(SAFE.contentBottom - SAFE.contentTop, 64 + 60 + rows * 50);
  const cardTop = Math.round(
    SAFE.contentTop + (SAFE.contentBottom - SAFE.contentTop - cardH) / 2,
  );
  return {
    cfg: { steps, totalChars },
    html: `
<div class="panel" style="left:${SAFE.margin}px; right:${SAFE.margin}px; top:${cardTop}px; height:${cardH}px; overflow:hidden;">
  <div style="height:64px; border-bottom:2px solid ${THEME.panelEdge}; display:flex; align-items:center; gap:14px; padding:0 26px;">
    <span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span>
    <span class="tab">zsh</span>
  </div>
  <pre id="term"></pre>
</div>`,
    js: `
const term = document.getElementById('term');
const steps = CFG.steps;
// Commands are typed; output lands whole (that is how a real session looks) but
// still costs time proportional to its length so long output does not dump.
const weights = steps.map(s => s.kind === 'command' ? s.text.length : Math.max(6, s.text.length * 0.35));
const total = weights.reduce((a,b) => a+b, 0);
const RUN = fill(total * 0.03);
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

let lastKey = '';
function render(t) {
  const budget = seg(t, BODY0, BODY0 + RUN) * total;
  let spent = 0, html = '', key = '';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], w = weights[i];
    if (budget <= spent) break;
    const p = Math.min(1, (budget - spent) / w);
    spent += w;
    if (s.kind === 'command') {
      const n = Math.round(s.text.length * p);
      html += '<span class="pr">$</span> <span class="cmd">' + esc(s.text.slice(0, n)) + '</span>';
      html += (p < 1 || i === steps.length - 1) ? '<span id="cur"></span>' : '';
      html += '\\n';
      key += n + ',';
    } else {
      html += '<span class="out" style="opacity:' + p.toFixed(2) + '">' + esc(s.text) + '</span>\\n';
      key += p.toFixed(2) + ',';
    }
  }
  if (key !== lastKey) { term.innerHTML = html; lastKey = key; }
  const cur = document.getElementById('cur');
  if (cur) cur.style.opacity = Math.floor(t * 2) % 2 === 0 ? 1 : 0.15;
}`,
  };
}

function buildDiagram(spec: Extract<GeneratedScene, { scene: "diagram" }>): Built {
  // Vertical stack: on a 9:16 frame a horizontal client→server layout leaves the
  // boxes tiny. Stacked, each node gets the full 920px of width.
  const n = spec.nodes.length;
  // Four or five nodes need more than the 620px content band, or the boxes end
  // up 35px apart with the packet dots landing on top of them (seen for real on
  // a 5-node render). The band grows upward/downward for bigger stacks; it still
  // clears the caption centre at y=1382.
  const top = n >= 4 ? 470 : SAFE.contentTop - 40;
  const bottom = n >= 4 ? 1250 : SAFE.contentBottom + 20;
  const GAP_MIN = 84;
  const boxH = Math.min(
    n <= 2 ? 150 : n === 3 ? 126 : 108,
    (bottom - top - (n - 1) * GAP_MIN) / n,
  );
  const gap = (bottom - top - n * boxH) / (n - 1);
  const y: Record<string, number> = {};
  spec.nodes.forEach((node, i) => {
    y[node.id] = top + i * (boxH + gap);
  });
  const missing = spec.edges.filter((e) => !(e.from in y) || !(e.to in y));
  if (missing.length) {
    // A dangling edge would silently draw nothing — exactly the "blank rectangle
    // that passes every check" failure §4a warns about. Fail at build time.
    throw new Error(
      `diagram scene: edge(s) reference unknown node ids: ` +
        missing.map((e) => `${e.from}->${e.to}`).join(", "),
    );
  }
  return {
    cfg: {
      gap,
      nodes: spec.nodes.map((nd) => ({ ...nd, y: y[nd.id]!, h: boxH })),
      edges: spec.edges.map((e) => ({
        ...e,
        y1: y[e.from]! + boxH,
        y2: y[e.to]!,
      })),
    },
    html: `<svg id="svg" width="1080" height="1920" style="position:absolute;inset:0;"></svg>`,
    js: `
const svg = document.getElementById('svg');
const NS = 'http://www.w3.org/2000/svg';
const nodes = CFG.nodes, edges = CFG.edges;
const X0 = ${SAFE.margin}, X1 = ${1080 - SAFE.margin}, CX = 540;
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (parent || svg).appendChild(e); return e;
}
// Static structure once; only opacity/offsets are animated per frame.
const nodeEls = nodes.map(function(nd, i) {
  const g = el('g', { opacity: 0 });
  const edge = i === 0 ? 'rgba(76,194,255,0.75)'
    : i === nodes.length - 1 ? 'rgba(225,29,46,0.75)' : '${THEME.panelEdge}';
  el('rect', { x: X0, y: nd.y, rx: 20, width: X1 - X0, height: nd.h,
    fill: '${THEME.panel}', stroke: edge, 'stroke-width': 3 }, g);
  const tx = el('text', { x: CX, y: nd.y + nd.h / 2 + 16, 'text-anchor': 'middle',
    fill: '${THEME.text}', 'font-family': ${JSON.stringify(THEME.display)}, 'font-size': 46 }, g);
  tx.textContent = nd.label;
  return g;
});
const edgeEls = edges.map(function(e) {
  const g = el('g', { opacity: 0 });
  // One rail per direction, offset either side of centre, so a 'both' edge
  // shows two-way traffic at every instant instead of alternating.
  const rails = e.direction === 'both' ? [-34, 34] : [0];
  rails.forEach(function(dx, i) {
    el('line', { x1: CX + dx, y1: e.y1 + 6, x2: CX + dx, y2: e.y2 - 6,
      stroke: i === 0 ? 'rgba(76,194,255,0.55)' : 'rgba(225,29,46,0.55)',
      'stroke-width': 5, 'stroke-dasharray': '12 14', 'stroke-linecap': 'round' }, g);
  });
  if (e.label) {
    // A chip behind the label: at 30px on a dashed rail the bare text was
    // unreadable in the first render.
    // The chip shrinks with the gap: at five nodes there is only ~84px between
    // boxes and a full-size chip overlapped both of them.
    const fs = CFG.gap < 110 ? 24 : 30;
    const h = fs + 20, w = e.label.length * fs * 0.5 + 40, my = (e.y1 + e.y2) / 2;
    el('rect', { x: CX - w / 2, y: my - h / 2, width: w, height: h, rx: h / 2,
      fill: '${THEME.bg}', stroke: '${THEME.panelEdge}', 'stroke-width': 2 }, g);
    const lab = el('text', { x: CX, y: my + fs / 3, fill: '${THEME.text}',
      'font-family': ${JSON.stringify(THEME.display)}, 'font-size': fs, 'text-anchor': 'middle' }, g);
    lab.textContent = e.label;
  }
  const dots = [el('circle', { r: 16, fill: '${THEME.cyan}' }, g)];
  // direction 'both' is the WebSocket case that motivated this module: a second
  // packet runs the other way on the opposite side of the line, so the frame
  // shows two-way traffic at every instant rather than alternating.
  if (e.direction === 'both') dots.push(el('circle', { r: 16, fill: '${THEME.accent}' }, g));
  return { g: g, dots: dots, e: e };
});

const IN0 = BODY0, IN1 = BODY0 + Math.min(1.0, BODYLEN * 0.35);
function render(t) {
  nodes.forEach(function(nd, i) {
    const p = ease(seg(t, IN0 + i * (IN1 - IN0) / Math.max(1, nodes.length), IN1 + i * 0.12));
    nodeEls[i].setAttribute('opacity', p.toFixed(3));
    nodeEls[i].setAttribute('transform', 'translate(0,' + ((1 - p) * 26).toFixed(1) + ')');
  });
  edgeEls.forEach(function(o, i) {
    const p = ease(seg(t, IN1 - 0.25 + i * 0.1, IN1 + 0.5 + i * 0.1));
    o.g.setAttribute('opacity', p.toFixed(3));
    // One packet trip every 1.6s, running for the whole clip so the diagram is
    // never a still image no matter how long the beat is.
    const phase = ((t - IN1) / 1.6) % 1;
    const q = phase < 0 ? 0 : easeInOut(phase);
    const y1 = o.e.y1 + 10, y2 = o.e.y2 - 10;
    o.dots[0].setAttribute('cx', o.dots.length > 1 ? CX - 34 : CX);
    o.dots[0].setAttribute('cy', (y1 + (y2 - y1) * q).toFixed(1));
    o.dots[0].setAttribute('opacity', (p * (0.35 + 0.65 * Math.sin(Math.PI * q))).toFixed(3));
    if (o.dots[1]) {
      o.dots[1].setAttribute('cx', CX + 34);
      o.dots[1].setAttribute('cy', (y2 + (y1 - y2) * q).toFixed(1));
      o.dots[1].setAttribute('opacity', (p * (0.35 + 0.65 * Math.sin(Math.PI * q))).toFixed(3));
    }
  });
}`,
  };
}

function buildMetric(spec: Extract<GeneratedScene, { scene: "metric" }>): Built {
  // Count up only the digits, keeping any prefix/suffix ("$", "ms", "×") fixed.
  const m = spec.value.match(/^([^\d]*)([\d][\d,._]*)(.*)$/);
  const numeric = m ? Number(m[2]!.replace(/[,_]/g, "")) : null;
  return {
    cfg: {
      prefix: m?.[1] ?? "",
      numeric,
      // Preserved so "1,000" counts up as "1,000" and not "1000".
      grouped: (m?.[2] ?? "").includes(","),
      decimals: (m?.[2] ?? "").includes(".") ? (m![2]!.split(".")[1]?.length ?? 0) : 0,
      suffix: m?.[3] ?? "",
      raw: spec.value,
    },
    html: `
<div id="mwrap" style="position:absolute; left:${SAFE.margin}px; right:${SAFE.margin}px; top:${SAFE.contentTop}px; text-align:center;">
  <div id="num" style="font-size:230px; line-height:1; letter-spacing:-0.02em; color:${THEME.text}; text-shadow:0 0 70px rgba(76,194,255,0.35);"></div>
  <div id="rule" style="height:6px; background:${THEME.accent}; margin:44px auto 0; width:0;"></div>
  <div id="lab" style="margin-top:40px; font-size:56px; color:#FFFFFF;">${esc(spec.label)}</div>
  ${spec.sublabel ? `<div id="sub" style="margin-top:20px; font-size:34px; letter-spacing:0.08em; color:${THEME.textDim};">${esc(spec.sublabel)}</div>` : ""}
</div>`,
    js: `
const numEl = document.getElementById('num'), ruleEl = document.getElementById('rule');
const labEl = document.getElementById('lab'), subEl = document.getElementById('sub');
// The count must NOT eat the whole beat: the label under it is the payload,
// and on a 3.2s beat a 1.4s count left it on screen for barely a second.
const COUNT1 = BODY0 + Math.min(BODYLEN * 0.6, fill(1.2));
function fmt(v) {
  let s = CFG.decimals ? v.toFixed(CFG.decimals) : String(Math.round(v));
  if (CFG.grouped) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    s = parts.join('.');
  }
  return CFG.prefix + s + CFG.suffix;
}
function render(t) {
  const p = ease(seg(t, BODY0, COUNT1));
  numEl.textContent = CFG.numeric === null ? CFG.raw : fmt(CFG.numeric * p);
  // Breathing scale after the count lands — a giant static number is the single
  // most freeze-prone scene, so it keeps a slow pulse for the whole clip.
  const pulse = 1 + 0.012 * Math.sin((t - COUNT1) * 1.6);
  numEl.style.transform = 'scale(' + (p < 1 ? (0.94 + 0.06 * p) : pulse).toFixed(4) + ')';
  ruleEl.style.width = (ease(seg(t, COUNT1 - 0.3, COUNT1 + 0.5)) * 360).toFixed(0) + 'px';
  const lp = ease(seg(t, COUNT1 - 0.25, COUNT1 + 0.35));
  labEl.style.opacity = lp.toFixed(3);
  labEl.style.transform = 'translateY(' + ((1 - lp) * 22).toFixed(1) + 'px)';
  if (subEl) {
    const sp = ease(seg(t, COUNT1 + 0.05, COUNT1 + 0.55));
    subEl.style.opacity = sp.toFixed(3);
    subEl.style.transform = 'translateY(' + ((1 - sp) * 18).toFixed(1) + 'px)';
  }
}`,
  };
}

function buildCompare(spec: Extract<GeneratedScene, { scene: "compare" }>): Built {
  const w = (1080 - SAFE.margin * 2 - 40) / 2;
  // Both columns get the SAME height, computed from whichever side is taller.
  // Ragged column bottoms looked like a rendering bug in the first pass.
  const colH = (items: string[]) =>
    34 + 56 + 30 + items.reduce((n, it) => n + Math.ceil(it.length / 24) * 45 + 22, 0) + 20;
  const height = Math.min(
    SAFE.contentBottom - SAFE.contentTop,
    Math.max(colH(spec.left.items), colH(spec.right.items)),
  );
  const top = Math.round(SAFE.contentTop + (SAFE.contentBottom - SAFE.contentTop - height) / 2);

  const col = (
    side: "l" | "r",
    data: { title: string; items: string[] },
    x: number,
    accent: string,
  ) => `
<div class="col" id="col-${side}" style="left:${x}px; top:${top}px; height:${height}px; border-top:6px solid ${accent};">
  <div class="ctitle" style="color:${accent}">${esc(data.title)}</div>
  ${data.items.map((it, i) => `<div class="item" id="${side}${i}">${esc(it)}</div>`).join("")}
</div>`;

  return {
    cfg: { n: Math.max(spec.left.items.length, spec.right.items.length) },
    html: `
<style>
.col { position:absolute; width:${w}px; background:${THEME.panel};
  border-radius:0 0 20px 20px; padding:34px 30px 40px; box-shadow:0 40px 90px rgba(0,0,0,0.5); }
.ctitle { font-size:44px; letter-spacing:0.04em; margin-bottom:30px; }
.item { font-size:34px; line-height:1.32; color:${THEME.text}; opacity:0; margin-bottom:22px;
  padding-left:34px; position:relative; }
.item:before { content:'—'; position:absolute; left:0; color:${THEME.textDim}; }
/* The VS chip sits ON the seam between the columns. Parked under them it fell
   into the caption band and read as stray text. */
#vs { position:absolute; left:${Math.round(540 - 46)}px; top:${Math.round(top + height / 2 - 46)}px;
  width:92px; height:92px; border-radius:50%; background:${THEME.bg};
  border:3px solid ${THEME.panelEdge}; color:${THEME.text}; font-size:34px; letter-spacing:0.08em;
  display:flex; align-items:center; justify-content:center; }
</style>
${col("l", spec.left, SAFE.margin, THEME.accent)}
${col("r", spec.right, SAFE.margin + w + 40, THEME.green)}
<div id="vs">VS</div>`,
    js: `
const cols = [document.getElementById('col-l'), document.getElementById('col-r')];
const items = [];
for (let i = 0; i < CFG.n; i++) {
  ['l','r'].forEach(function(s) { const e = document.getElementById(s + i); if (e) items.push(e); });
}
const vs = document.getElementById('vs');
const COL1 = BODY0 + Math.min(0.7, BODYLEN * 0.25);
// Items are staggered across the WHOLE remaining body, so the same three bullets
// land briskly in a 3s beat and unhurriedly in a 9s one.
const step = Math.max(0.12, (BODY1 - COL1) / (items.length + 1));
function render(t) {
  cols.forEach(function(c, i) {
    const p = ease(seg(t, BODY0 + i * 0.12, COL1 + i * 0.12));
    c.style.opacity = p.toFixed(3);
    c.style.transform = 'translateX(' + ((1 - p) * (i === 0 ? -40 : 40)).toFixed(1) + 'px)';
  });
  items.forEach(function(e, i) {
    const p = ease(seg(t, COL1 + i * step, COL1 + i * step + step * 1.4));
    e.style.opacity = p.toFixed(3);
    e.style.transform = 'translateY(' + ((1 - p) * 16).toFixed(1) + 'px)';
  });
  const vp = ease(seg(t, COL1, COL1 + 0.5));
  vs.style.opacity = vp.toFixed(3);
  vs.style.transform = 'scale(' + (0.8 + 0.2 * vp + 0.02 * Math.sin(t * 1.6)).toFixed(4) + ')';
}`,
  };
}

function buildParticles(spec: Extract<GeneratedScene, { scene: "particles" }>): Built {
  const moods = {
    network: { count: 1400, color: THEME.cyan, spread: 900, speed: 0.06, size: 7, links: true },
    data: { count: 2600, color: THEME.green, spread: 1100, speed: 0.1, size: 5, links: false },
    calm: { count: 900, color: "#9FB6CC", spread: 1300, speed: 0.03, size: 9, links: false },
  } as const;
  return {
    three: true,
    cfg: { mood: spec.mood, ...moods[spec.mood] },
    html: `<canvas id="gl" width="1080" height="1920" style="position:absolute;inset:0;"></canvas>`,
    js: `
const THREE = window.THREE;
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
renderer.setPixelRatio(1);
renderer.setSize(1080, 1920, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1080 / 1920, 1, 4000);
camera.position.z = 900;

// Deterministic point cloud: a seeded LCG, not Math.random, so two renders of
// the same spec produce the same field (PRD §4a: deterministic).
let seed = 20260813;
function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }

const N = CFG.count, S = CFG.spread;
const pos = new Float32Array(N * 3);
const drift = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  pos[i*3] = (rnd() - 0.5) * S * 1.2;
  pos[i*3+1] = (rnd() - 0.5) * S * 2.0;
  pos[i*3+2] = (rnd() - 0.5) * S;
  drift[i*3] = (rnd() - 0.5);
  drift[i*3+1] = (rnd() - 0.5);
  drift[i*3+2] = (rnd() - 0.5);
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
// PointsMaterial with no map draws hard SQUARES (visible at 1080p in the first
// render). The sprite is painted in-page rather than loaded, keeping the render
// offline and deterministic.
const spr = document.createElement('canvas');
spr.width = spr.height = 64;
const sctx = spr.getContext('2d');
const grd = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
grd.addColorStop(0, 'rgba(255,255,255,1)');
grd.addColorStop(0.45, 'rgba(255,255,255,0.75)');
grd.addColorStop(1, 'rgba(255,255,255,0)');
sctx.fillStyle = grd;
sctx.fillRect(0, 0, 64, 64);
const mat = new THREE.PointsMaterial({ color: new THREE.Color(CFG.color), size: CFG.size * 2.4,
  map: new THREE.CanvasTexture(spr), transparent: true, opacity: 0.9, depthWrite: false,
  blending: THREE.AdditiveBlending });
const points = new THREE.Points(geo, mat);
scene.add(points);

let lines = null;
if (CFG.links) {
  // Links only between points that are actually NEAR each other. Linking random
  // index pairs (the first attempt) drew chords across the whole frame and read
  // as scratches on the lens, not as a network.
  const lp = [];
  const MAXD = 190 * 190;
  for (let a = 0; a < N && lp.length < 240 * 6; a++) {
    for (let b = a + 1; b < Math.min(N, a + 40); b++) {
      const dx = pos[a*3]-pos[b*3], dy = pos[a*3+1]-pos[b*3+1], dz = pos[a*3+2]-pos[b*3+2];
      if (dx*dx + dy*dy + dz*dz < MAXD) {
        lp.push(pos[a*3], pos[a*3+1], pos[a*3+2], pos[b*3], pos[b*3+1], pos[b*3+2]);
        break;
      }
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
  lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
    color: new THREE.Color(CFG.color), transparent: true, opacity: 0.30 }));
  scene.add(lines);
}

const base = pos.slice();
function render(t) {
  const p = ease(seg(t, 0, Math.min(1.2, T * 0.4)));
  mat.opacity = 0.9 * p;
  if (lines) lines.material.opacity = 0.22 * p;
  const arr = geo.attributes.position.array;
  for (let i = 0; i < N; i++) {
    arr[i*3]   = base[i*3]   + Math.sin(t * CFG.speed * 6 + drift[i*3] * 9) * 26;
    arr[i*3+1] = base[i*3+1] + (t * CFG.speed * 40 * drift[i*3+1]);
    arr[i*3+2] = base[i*3+2] + Math.cos(t * CFG.speed * 5 + drift[i*3+2] * 9) * 26;
  }
  geo.attributes.position.needsUpdate = true;
  points.rotation.y = t * 0.05;
  if (lines) lines.rotation.y = t * 0.05;
  camera.position.z = 900 - 90 * ease(seg(t, 0, T));
  renderer.render(scene, camera);
}`,
  };
}

function buildScene(spec: GeneratedScene): Built {
  switch (spec.scene) {
    case "code": return buildCode(spec);
    case "terminal": return buildTerminal(spec);
    case "diagram": return buildDiagram(spec);
    case "metric": return buildMetric(spec);
    case "compare": return buildCompare(spec);
    case "particles": return buildParticles(spec);
  }
}

const SCENE_CSS = `
pre { font-family:${THEME.mono}; padding:30px 34px; white-space:pre; }
#code { font-size:var(--fs); line-height:1.55; white-space:pre-wrap; word-break:break-all; }
#term { font-size:31px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }
.tab { font-family:${THEME.display}; font-size:26px; letter-spacing:0.14em; text-transform:uppercase;
  color:${THEME.textDim}; margin-left:14px; }
.dot { width:16px; height:16px; border-radius:50%; display:inline-block; }
.kw { color:#FF7AB2; } .st { color:${THEME.green}; } .cm { color:#6B8199; font-style:italic; }
.nu { color:${THEME.amber}; } .fn { color:${THEME.cyan}; } .id { color:${THEME.text}; }
.pn { color:#93A9BE; } .tx { color:${THEME.text}; }
.pr { color:${THEME.accent}; } .cmd { color:${THEME.text}; } .out { color:${THEME.textDim}; }
#cur { display:inline-block; width:16px; height:1em; background:${THEME.cyan};
  vertical-align:-3px; margin-left:3px; }
#hl { position:absolute; inset:0; pointer-events:none; }
`;

export async function buildPage(spec: GeneratedScene, durationS: number): Promise<string> {
  const built = buildScene(spec);
  const threeSrc = built.three ? await inlineThree() : "";
  const fs = spec.scene === "code" ? (built.cfg.fontSize as number) : 34;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${BASE_CSS}${SCENE_CSS}
:root { --fs:${fs}px; }
</style></head>
<body>
<div id="bgA"></div><div id="bgB"></div><div id="grid"></div>
<div id="stage">${built.html}</div>
<div id="capband"></div>
<div id="preroll" style="position:fixed;inset:0;background:#fff;z-index:99"></div>
<script>${threeSrc}</script>
<script>
window.addEventListener('error', function(e) { window.__sceneError = String(e.message); });
const CFG = Object.assign(${json(built.cfg)}, { durationS: ${durationS} });
${RUNTIME_JS}
${built.js}
</script>
</body></html>`;
}
