/**
 * The "studio" layout — the OnePrompt-style frame (docs/oneprompt-teardown.md §3):
 *
 *   ┌──────────────────────────────┐
 *   │ brand   ( ● CHAPTER ▬▬▭▭ ) ? │  chrome (beats with a chapter)
 *   │       context  [KEYWORD]     │  1–3 word captions, emphasis boxed
 *   │                              │
 *   │        hero visual           │  generated scene (full-bleed, themed)
 *   │                              │  or footage framed as a card
 *   │ source, 2024                 │  footnote
 *   │           (host)             │  pose library + mouth flap
 *   └──────────────────────────────┘
 *
 * Everything here is PURE (strings in, strings out) so it can be unit-tested
 * without a browser; compose.ts stitches it into the HyperFrames project and
 * stages the files it references.
 *
 * Timing model: every visible layer is a HyperFrames timed element
 * (`data-start` / `data-duration`, seconds), exactly like the classic layout.
 * The only GSAP is the mouth flap: `tl.set` opacity toggles on the timeline,
 * which the renderer seeks deterministically.
 */
import { roundSeconds } from "./units.js";
import { escapeHtml } from "./styles.js";
import type { WordTiming } from "./captions.js";
import {
  POSES,
  DEFAULT_POSE,
  IDLE_CYCLE,
  SOFT_POSES,
  HOLD_MAX_S,
  HOLD_MIN_S,
  posesForWords,
  normalizeToken,
} from "../host/poses.js";

export type Theme = "light" | "dark";

/** Font files the studio layout needs (staged by compose.ts, resolved from vault/fonts). */
/**
 * Timeless Sans (the user's custom cut, Timeless Free Font License — see
 * vault/fonts/TimelessSans-W430/) is the voice of the frame: captions, brand,
 * badge. It ships ONE weight (W430), so emphasis is carried by the selection
 * box and full contrast, never by a synthesized bold. Inter Bold (OFL) does
 * the small uppercase labels (chapter pill, footnotes).
 */
export const STUDIO_FONT_FILES = [
  { family: "Timeless Sans", weight: 430, file: "TimelessSans-W430.ttf" },
  { family: "Inter", weight: 700, file: "Inter-Bold.ttf" },
] as const;

// ─── themes ─────────────────────────────────────────────────────────────────

/**
 * Light/dark per beat. The hook (beats before the first chapter) is dark —
 * a dark, lit object is the strongest first frame — and every chapter change
 * flips the theme, which doubles as a soft chapter break (teardown §3).
 * Shared with asset acquisition so generated scenes are rendered on the
 * matching background.
 */
export function themesForBeats(beats: Array<{ chapter?: string }>): Theme[] {
  let theme: Theme = "dark";
  let prev: string | undefined;
  return beats.map((b, i) => {
    if (i > 0 && b.chapter !== prev && b.chapter !== undefined) {
      theme = theme === "dark" ? "light" : "dark";
    }
    prev = b.chapter ?? prev;
    return theme;
  });
}

// ─── host: pose schedule + mouth flap ───────────────────────────────────────

export interface GlobalWord extends WordTiming {
  /** Index into the whole video's word stream. */
  index: number;
}

export interface PoseSegment {
  pose: string;
  startS: number;
  endS: number;
}

/** Lead the word slightly — a gesture that lands ON the word reads as late. */
const POSE_LEAD_S = 0.12;

/**
 * Which pose is up when. Trigger words switch poses (respecting HOLD_MIN_S so
 * back-to-back triggers don't strobe); with no trigger, the host moves to the
 * next idle pose once a pose has been up HOLD_MAX_S — so he never freezes.
 * Only `available` poses are scheduled (the library may be partly drawn).
 */
export function scheduleHost(
  words: GlobalWord[],
  totalS: number,
  available: Set<string>,
): PoseSegment[] {
  let idle = IDLE_CYCLE.filter((p) => available.has(p));
  if (idle.length < 3) idle = SOFT_POSES.filter((p) => available.has(p));
  const first = available.has(DEFAULT_POSE) ? DEFAULT_POSE : (idle[0] ?? [...available][0]);
  if (!first) return [];
  const triggers = posesForWords(words.map((w) => w.word));

  const segments: PoseSegment[] = [];
  let current = first;
  let currentStart = 0;
  let idleIdx = Math.max(0, idle.indexOf(first));

  const switchTo = (pose: string, atS: number) => {
    const t = roundSeconds(Math.max(currentStart + HOLD_MIN_S, atS));
    if (pose === current || t >= totalS) return;
    segments.push({ pose: current, startS: currentStart, endS: t });
    current = pose;
    currentStart = t;
  };

  /** A trigger may be deferred to honour HOLD_MIN_S, but not so far it misses its word. */
  const MAX_DEFER_S = 0.5;

  for (const [i, w] of words.entries()) {
    const at = Math.max(0, w.startS - POSE_LEAD_S);
    const trig = triggers[i];
    if (trig && available.has(trig) && trig !== current && segments.length === 0 && at < HOLD_MIN_S) {
      // A trigger in the opening words sets the opening pose ("Did you know…" → point-up).
      current = trig;
      currentStart = 0;
    } else if (
      trig && available.has(trig) && trig !== current &&
      currentStart + HOLD_MIN_S - at <= MAX_DEFER_S
    ) {
      switchTo(trig, at);
    } else if (at - currentStart >= HOLD_MAX_S && idle.length > 0) {
      idleIdx = (idleIdx + 1) % idle.length;
      let next = idle[idleIdx]!;
      if (next === current && idle.length > 1) {
        idleIdx = (idleIdx + 1) % idle.length;
        next = idle[idleIdx]!;
      }
      switchTo(next, at);
    }
  }
  segments.push({ pose: current, startS: currentStart, endS: roundSeconds(totalS) });
  return segments;
}

/** Open-mouth intervals: flaps at ~5.5 Hz while a word is spoken, closed in gaps. */
export function mouthIntervals(words: WordTiming[]): Array<{ startS: number; endS: number }> {
  const OPEN = 0.11;
  const PERIOD = 0.18;
  const out: Array<{ startS: number; endS: number }> = [];
  for (const w of words) {
    let t = w.startS;
    do {
      const end = Math.min(t + OPEN, w.endS);
      if (end - t >= 0.04) out.push({ startS: roundSeconds(t), endS: roundSeconds(end) });
      t += PERIOD;
    } while (t < w.endS - 0.05);
  }
  return out;
}

// ─── captions ───────────────────────────────────────────────────────────────

export interface CaptionGroup {
  startS: number;
  endS: number;
  words: Array<WordTiming & { em: boolean }>;
}

const MAX_GROUP_WORDS = 3;
const GROUP_GAP_S = 0.35;

/** Marks which words of `words` are covered by an `emphasis` phrase. */
export function emphasisMask(words: string[], emphasis: string[] = []): boolean[] {
  const tokens = words.map(normalizeToken);
  const mask = new Array(words.length).fill(false);
  for (const phrase of emphasis) {
    const parts = phrase.split(/\s+/).map(normalizeToken).filter(Boolean);
    if (parts.length === 0) continue;
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      if (parts.every((p, k) => tokens[i + k] === p)) {
        for (let k = 0; k < parts.length; k++) mask[i + k] = true;
      }
    }
  }
  return mask;
}

/**
 * Splits a beat's words into on-screen groups of ≤3 words, breaking after
 * punctuation and at pauses. A group stays up until the next one starts, so the
 * top of the frame is never empty mid-sentence. Times are beat-relative.
 */
export function captionGroups(
  words: WordTiming[],
  emphasis: string[] | undefined,
  beatEndS: number,
): CaptionGroup[] {
  const em = emphasisMask(words.map((w) => w.word), emphasis);
  const groups: CaptionGroup[] = [];
  let cur: CaptionGroup["words"] = [];
  const flush = () => {
    if (cur.length) groups.push({ startS: cur[0]!.startS, endS: cur.at(-1)!.endS, words: cur });
    cur = [];
  };
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    if (cur.length && prev && w.startS - prev.endS > GROUP_GAP_S) flush();
    cur.push({ ...w, em: em[i]! });
    if (cur.length >= MAX_GROUP_WORDS || /[.,?!:;—]$/.test(w.word)) flush();
  }
  flush();
  // Appear a hair before the first word; hold each group until the next one
  // appears (no empty frames mid-sentence); the last holds to the beat end.
  for (const g of groups) g.startS = roundSeconds(Math.max(0, g.startS - 0.04));
  for (let i = 0; i < groups.length; i++) {
    const next = groups[i + 1];
    // The last group holds to the beat's end — never past it, or it overlaps
    // the next beat's first caption (seen as "Seikgears." in the first reel).
    groups[i]!.endS = roundSeconds(next ? next.startS : beatEndS);
  }
  return groups;
}

// ─── HTML layers ────────────────────────────────────────────────────────────

export interface StudioBeat {
  beatId: string;
  startS: number;
  durationS: number;
  theme: Theme;
  chapter?: string;
  emphasis?: string[];
  sourceNote?: string;
  /** Beat-relative word timings, already aligned to vo_text. */
  words: WordTiming[];
}

export function backdropHtml(b: StudioBeat): string {
  return (
    `<div class="clip backdrop backdrop--${b.theme}" id="bg-${escapeHtml(b.beatId)}" ` +
    `data-start="${b.startS}" data-duration="${b.durationS}"></div>`
  );
}

/** Chrome bar: one clip per contiguous chapter run (so it doesn't flicker at beat cuts). */
export function chromeHtml(beats: StudioBeat[], brand: string): string[] {
  const chapters = [...new Set(beats.map((b) => b.chapter).filter((c): c is string => !!c))];
  const out: string[] = [];
  let i = 0;
  while (i < beats.length) {
    const b = beats[i]!;
    if (!b.chapter) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < beats.length && beats[j + 1]!.chapter === b.chapter && beats[j + 1]!.theme === b.theme) j++;
    const last = beats[j]!;
    const start = b.startS;
    const dur = roundSeconds(last.startS + last.durationS - start);
    const idx = chapters.indexOf(b.chapter);
    const dashes = chapters
      .map((_, k) => `<i class="dash${k < idx ? " dash--done" : k === idx ? " dash--now" : ""}"></i>`)
      .join("");
    out.push(
      `<div class="clip chrome chrome--${b.theme}" id="chrome-${i}" data-start="${start}" data-duration="${dur}">` +
        `<span class="chrome__brand"><b class="chrome__mark"></b>${escapeHtml(brand)}</span>` +
        `<span class="chrome__pill"><i class="chrome__dot"></i>${escapeHtml(b.chapter.toUpperCase())}` +
        `<span class="chrome__dashes">${dashes}</span></span>` +
        `<span class="chrome__badge">?</span>` +
        `</div>`,
    );
    i = j + 1;
  }
  return out;
}

export function captionsStudioHtml(b: StudioBeat): string[] {
  const groups = captionGroups(b.words, b.emphasis, b.durationS);
  return groups.map((g, gi) => {
    const gStart = roundSeconds(b.startS + g.startS);
    const gEnd = roundSeconds(b.startS + g.endS);
    // Consecutive emphasis words share one selection box.
    const parts: string[] = [];
    let k = 0;
    while (k < g.words.length) {
      const run: typeof g.words = [];
      const em = g.words[k]!.em;
      while (k < g.words.length && g.words[k]!.em === em) run.push(g.words[k++]!);
      const spans = run.map((w, wi) => {
        const ws = roundSeconds(b.startS + w.startS);
        const nextStart = run[wi + 1]?.startS ?? g.words[k]?.startS;
        const onEnd = roundSeconds(nextStart !== undefined ? b.startS + nextStart : gEnd);
        const text = escapeHtml(w.word);
        return (
          `<span class="clip cw" data-start="${ws}" data-duration="${roundSeconds(gEnd - ws)}">${text}` +
          `<span class="clip cw__on" data-start="${ws}" data-duration="${roundSeconds(Math.max(0.05, onEnd - ws))}">${text}</span>` +
          `</span>`
        );
      });
      if (em) {
        const boxStart = roundSeconds(b.startS + run[0]!.startS);
        parts.push(
          `<span class="clip cem" data-start="${boxStart}" data-duration="${roundSeconds(gEnd - boxStart)}">` +
            spans.join(" ") +
            `</span>`,
        );
      } else parts.push(spans.join(" "));
    }
    return (
      `<div class="clip cap cap--${b.theme}" id="cap-${escapeHtml(b.beatId)}-${gi}" ` +
      `data-start="${gStart}" data-duration="${roundSeconds(gEnd - gStart)}">${parts.join(" ")}</div>`
    );
  });
}

export function footnoteHtml(b: StudioBeat): string {
  if (!b.sourceNote) return "";
  return (
    `<div class="clip footnote footnote--${b.theme}" id="fn-${escapeHtml(b.beatId)}" ` +
    `data-start="${b.startS}" data-duration="${b.durationS}">${escapeHtml(b.sourceNote)}</div>`
  );
}

/** Measured pose geometry (src/host/measure.ts PoseMeta). */
export interface PoseGeometry {
  width: number;
  height: number;
  headTop: number;
  bodyBottom?: number;
  mouth: { x: number; y: number; w: number; h: number };
}

/** The host's box on the canvas (bottom-centred); poses may overflow it sideways. */
export const HOST_BOX = { w: 600, h: 760 } as const;
/** Native→canvas scale for a 896-wide pose drawing at head-size parity. */
const HOST_BASE_SCALE = 0.62;
/** Frame edge distance below the mouth, in head-top→mouth units (≈ just above the waist). */
const HOST_CUT_HEADS = 1.6;
/** Reference head-top→mouth distance (native px) every pose is scaled toward. */
const HOST_HEAD_PX = 300;

/**
 * Where one pose drawing sits inside HOST_BOX. Poses come back from the image
 * model framed slightly differently (thighs vs waist), so the head size would
 * jump on every swap. Each pose is scaled toward a common head size (clamped,
 * so a badly-framed drawing can't balloon), bottom-anchored (the body always
 * reaches the frame edge — no floating torso), and centred on its mouth so the
 * head stays put while the arms move.
 */
export function placePose(m: PoseGeometry): {
  width: number;
  left: number;
  top: number;
  mask: string;
} {
  const d = Math.max(1, m.mouth.y - m.headTop);
  const s = HOST_BASE_SCALE * Math.min(1.35, Math.max(0.7, HOST_HEAD_PX / d));
  const width = m.width * s;
  const left = HOST_BOX.w / 2 - m.mouth.x * s;
  // SAME CROP ON EVERY POSE: the mouth sits at one fixed height and the frame
  // edge is HOST_CUT_HEADS head-units below it. Heads are normalised to one
  // size, so every pose is cut at the same body level (just above the waist)
  // — anchoring each drawing's own bottom edge cut some at the waist and
  // others at the thighs, which read as the host shrinking and growing.
  const cutBelowMouth = HOST_CUT_HEADS * HOST_HEAD_PX * HOST_BASE_SCALE;
  let top = HOST_BOX.h - cutBelowMouth - m.mouth.y * s;
  // A drawing too short to reach the frame edge there would leave a gap under
  // the host: anchor its own body bottom instead (+2% so the edge is the cut).
  const bodyBottom = (m.bodyBottom ?? m.height - 1) + m.height * 0.02;
  if (top + bodyBottom * s < HOST_BOX.h) top = HOST_BOX.h - bodyBottom * s;
  // The diff-measured mouth sits low (the open drawing drops the jaw), so the
  // mask centre is lifted and sized to cover lips + jaw, feathered at the edge.
  const cx = m.mouth.x * s;
  const cy = (m.mouth.y - 0.3 * m.mouth.w) * s;
  const rx = m.mouth.w * 1.05 * s;
  const ry = m.mouth.w * 0.85 * s;
  const r = (n: number) => Math.round(n * 10) / 10;
  const mask = `radial-gradient(ellipse ${r(rx)}px ${r(ry)}px at ${r(cx)}px ${r(cy)}px, #000 55%, transparent 100%)`;
  return { width: r(width), left: r(left), top: r(top), mask };
}

/**
 * Host layer: per pose segment a timed wrapper holding the closed drawing and
 * the open one masked to the mouth; `tl.set` toggles the open one on each
 * audio-driven flap. Returns HTML plus the JS that registers the flaps on the
 * composition timeline (`tl` must be in scope).
 */
export function hostLayer(
  segments: PoseSegment[],
  mouth: Array<{ startS: number; endS: number }>,
  themeAt: (s: number) => Theme,
  poseSrc: (pose: string, open: boolean) => string,
  geometry?: (pose: string) => PoseGeometry | undefined,
): { html: string[]; js: string } {
  const html: string[] = [];
  segments.forEach((seg, i) => {
    const dur = roundSeconds(seg.endS - seg.startS);
    if (dur <= 0) return;
    const theme = themeAt(seg.startS + dur / 2);
    const g = geometry?.(seg.pose);
    const place = g ? placePose(g) : undefined;
    const imgStyle = place
      ? ` style="left:${place.left}px; top:${place.top}px; width:${place.width}px; bottom:auto;"`
      : "";
    const openStyle = place
      ? ` style="left:${place.left}px; top:${place.top}px; width:${place.width}px; bottom:auto; ` +
        `-webkit-mask-image:${place.mask}; mask-image:${place.mask};"`
      : "";
    // The TIMED element is a div: the HyperFrames runtime sizes timed media
    // (img/video) to the canvas itself, which overrode our host sizing and
    // drew the host canvas-wide. Untimed imgs inside a timed div keep our CSS.
    html.push(
      `<div class="clip host host--${theme}" id="host-${i}" data-start="${seg.startS}" data-duration="${dur}">` +
        `<img class="host__img"${imgStyle} alt="" src="${escapeHtml(poseSrc(seg.pose, false))}" />` +
        `<img class="host__img host__open" id="hopen-${i}"${openStyle} alt="" src="${escapeHtml(poseSrc(seg.pose, true))}" />` +
        `</div>`,
    );
  });
  const flaps: Array<[number, number, number]> = [];
  for (const m of mouth) {
    const seg = segments.findIndex((s) => m.startS >= s.startS && m.startS < s.endS);
    if (seg >= 0) flaps.push([seg, m.startS, Math.min(m.endS, segments[seg]!.endS)]);
  }
  const js =
    `const FLAPS = ${JSON.stringify(flaps)};\n` +
    `      for (const [i, a, b] of FLAPS) { const el = document.getElementById("hopen-" + i);` +
    ` tl.set(el, { opacity: 1 }, a); tl.set(el, { opacity: 0 }, b); }`;
  return { html, js };
}

/** Footage (stock / screenrec / still) sits in a framed card on the studio backdrop. */
export const STAGE_CARD_STYLE =
  "inset: auto !important; left: 56px !important; top: 330px !important; " +
  "width: 968px !important; height: 860px !important;";

export function studioCss(fontFaces: string, accent = "#3B82F6"): string {
  const hex = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#3B82F6";
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
  return `
    ${fontFaces}
    :root { --accent: ${hex}; --accent-rgb: ${rgb}; }
    .backdrop--light {
      background-color: #F2F2EF;
      background-image:
        radial-gradient(ellipse 70% 45% at 50% 42%, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%),
        linear-gradient(rgba(0,0,0,0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,0,0,0.045) 1px, transparent 1px);
      background-size: auto, 90px 90px, 90px 90px;
    }
    .backdrop--dark {
      background-color: #0E0E10;
      background-image:
        radial-gradient(ellipse 55% 60% at 50% 18%, rgba(255,255,255,0.13), rgba(255,255,255,0) 70%),
        radial-gradient(ellipse 80% 30% at 50% 72%, rgba(255,255,255,0.05), rgba(255,255,255,0) 70%);
    }
    .stage-card {
      border-radius: 34px; object-fit: cover;
      box-shadow: 0 40px 90px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06);
    }

    .chrome {
      inset: auto; left: 44px; right: 44px; top: 64px; height: 72px;
      display: flex; align-items: center; justify-content: space-between;
      font-family: "Timeless Sans"; font-weight: 430;
    }
    .chrome__brand { display: flex; align-items: center; gap: 12px; font-size: 32px; letter-spacing: -0.01em; }
    .chrome__mark { width: 30px; height: 30px; border-radius: 8px; border: 4px solid currentColor; }
    .chrome__pill {
      display: flex; align-items: center; gap: 16px; padding: 14px 26px; border-radius: 999px;
      font-family: "Inter"; font-weight: 700; font-size: 24px; letter-spacing: 0.14em;
    }
    .chrome__dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); }
    .chrome__dashes { display: flex; gap: 6px; margin-left: 10px; }
    .dash { width: 22px; height: 6px; border-radius: 3px; opacity: 0.25; background: currentColor; }
    .dash--done { opacity: 0.6; background: var(--accent); }
    .dash--now { opacity: 1; background: var(--accent); width: 34px; }
    .chrome__badge {
      width: 66px; height: 66px; border-radius: 50%; display: grid; place-items: center;
      background: var(--accent); color: #fff; font-size: 36px; font-weight: 430;
      box-shadow: 0 0 0 6px rgba(var(--accent-rgb),0.18), 0 10px 30px rgba(var(--accent-rgb),0.45);
    }
    .chrome--light { color: #121212; }
    .chrome--light .chrome__pill { background: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.08); }
    .chrome--dark { color: #F4F4F5; }
    .chrome--dark .chrome__pill { background: rgba(255,255,255,0.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12); }

    .cap {
      inset: auto; left: 60px; right: 60px; top: 196px; min-height: 110px;
      text-align: center; font-family: "Timeless Sans"; font-weight: 430; font-size: 68px;
      line-height: 1.12; letter-spacing: -0.02em;
    }
    .cap .clip { position: relative; inset: auto; }
    .cap .cw { display: inline-block; }
    .cap .cw__on { position: absolute; left: 0; top: 0; }
    .cap--light .cw { color: #9A9A9F; }
    .cap--light .cw__on { color: #0E0E10; }
    .cap--dark .cw { color: #8C8C92; }
    .cap--dark .cw__on { color: #FFFFFF; }
    .cem {
      position: relative; display: inline-block; padding: 0 12px; margin: 0 4px;
      border: 3px solid var(--accent); background: rgba(var(--accent-rgb),0.14);
    }
    .cap--light .cem .cw { color: #0E0E10; }
    .cap--dark .cem .cw { color: #FFFFFF; }
    .cem::before, .cem::after {
      content: ""; position: absolute; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; border: 3px solid var(--accent);
    }
    .cem::before { left: -11px; top: -11px; }
    .cem::after { right: -11px; bottom: -11px; }

    .footnote {
      inset: auto; left: 48px; top: 1236px; max-width: 400px;
      font-family: "Inter"; font-weight: 700; font-size: 21px; line-height: 1.35;
      letter-spacing: 0.02em;
    }
    .footnote--light { color: rgba(0,0,0,0.42); }
    .footnote--dark { color: rgba(255,255,255,0.42); }

    .host { inset: auto; left: 50%; bottom: 0; top: auto; width: ${HOST_BOX.w}px; height: ${HOST_BOX.h}px; transform: translateX(-50%); overflow: visible; }
    .host__img { position: absolute; left: 0; bottom: 0; width: 100%; height: auto; }
    .host__open { opacity: 0; }
    .host--dark {
      filter: drop-shadow(0 0 1.5px rgba(255,255,255,0.95)) drop-shadow(0 0 22px rgba(255,255,255,0.16));
    }
    .host--light { filter: drop-shadow(0 14px 28px rgba(0,0,0,0.18)); }
  `;
}

/** Every pose id the catalog knows — compose checks which have images on disk. */
export const ALL_POSE_IDS = POSES.map((p) => p.id);
