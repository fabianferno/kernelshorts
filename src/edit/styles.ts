/**
 * Composition styles and title treatments — HyperFrames port of
 * `text-styles.ts`. Same fonts, sizes, spacing, variant cycle, and scrim
 * predicate, carried over BY VALUE (see that file for the tuning notes);
 * what changes is the output shape — CSS and DOM instead of Palmier
 * add_texts arguments.
 *
 * Does not import from text-styles.ts — a later task deletes that file.
 */

/**
 * Fonts are installed to ~/Library/Fonts and kept in vault/fonts/. All were
 * rendered live and confirmed before being listed here.
 *
 * LICENCES — none of these three are commercially free:
 *   Coolvetica ............... personal use only — Typodermic
 *   Herkey ................... personal use only — HansCo
 *   Relationship of Mélodrame  personal use only — Sizimon
 * Butler (100% free, commercial OK) is installed and available if a
 * commercially-safe face is ever needed; it is not in the rotation.
 * See vault/fonts/<font>/LICENSE.md.
 */
export const FONTS = {
  coolvetica: "Coolvetica",
  herkey: "Herkey",
  melodrame: "relationship of mélodrame",
} as const;

export type FontKey = keyof typeof FONTS;

/**
 * Caption face: "Coolvetica Rg It.otf", which registers with the FULL NAME
 * "Coolvetica Italic" (family is plain "Coolvetica" — asking for the family
 * alone gets you the upright).
 */
export const CAPTION_FONT = "Coolvetica Italic";

/**
 * CALIBRATED TO PALMIER — DO NOT "TIDY" THESE BACK TO ROUND NUMBERS.
 *
 * text-styles.ts documents its sizes as "px at 1080x1920", and they were
 * ported here by value on that basis. The Task 8 parity render proved that
 * comment wrong: as literal CSS px on a 1080x1920 canvas they render text at
 * about 56% of the size Palmier actually produced, because Palmier evidently
 * treated them as coordinates in a smaller reference space and scaled up on
 * export. 1080/600 = 1.8, so a 600-wide reference space explains the factor
 * exactly.
 *
 * The factor was MEASURED, not assumed, from matched frames of
 * `~/pipeline/runs/2026-08-18/exports/hn-2026-08-18-v1-master.mp4` (the
 * iteration whose assets match the run manifest) against the HyperFrames
 * render, at each beat's midpoint. Glyph bounding boxes for the identical
 * string in the identical face:
 *
 *   why_it_matters @14.80s, Mélodrame, "Analyze 150GB locally"
 *     Palmier 804x107 px   HyperFrames 449x58 px   -> 1.790 wide, 1.845 tall
 *   hook @2.67s, Coolvetica, "40x faster queries"
 *     Palmier 584x72 px    HyperFrames 326x40 px   -> 1.791 wide, 1.800 tall
 *
 * Two different faces agreeing to three decimal places is why this is one
 * global PALMIER_SCALE rather than a per-element fudge. Herkey has no titled
 * beat in that run, so it inherits the same factor.
 */
export const PALMIER_SCALE = 1.8;

/**
 * Vertical CENTRE of the title block, as a fraction of frame height,
 * CALIBRATED TO PALMIER. Measured glyph-box centres in `v1-master`: 0.2370
 * (why_it_matters) and 0.2456 (hook); 0.24 is the round number between them.
 * Comfortably clear of SAFE_AREA.topClear (0.1) at every title size.
 */
export const TITLE_CENTER_Y = 0.24;

/** Percentages in the CSS below — keeps `24%` from becoming `24.000000001%`. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Per-font base size, in px at 1080x1920, calibrated as described above.
 * Palmier's own numbers were 44 / 46 / 68 in its reference space.
 *
 * These faces have very different metrics: at a shared 70px Mélodrame set two
 * tidy lines while the others wrapped to four and overflowed. The RATIOS
 * between them are Palmier's, set by rendering the same phrase in each face and
 * matching their optical size; only the common scale changed.
 */
const BASE_SIZE: Record<FontKey, number> = {
  coolvetica: 79, // 44 * 1.8
  herkey: 83, // 46 * 1.8
  melodrame: 122, // 68 * 1.8
};

/**
 * Line height per font. Tight spacing keeps these display faces compact, but
 * the right amount is per-face: at a shared −18 Herkey's two lines physically
 * collided (its ascenders are tall), while Mélodrame still looked airy.
 *
 * Scaled by PALMIER_SCALE with the sizes — these are px offsets on top of 1em,
 * so leaving them unscaled while the type grew 1.8x would quietly loosen every
 * multi-line title.
 */
const LINE_SPACING: Record<FontKey, number> = {
  coolvetica: -25, // -14 * 1.8
  herkey: 4, // 2 * 1.8
  melodrame: -32, // -18 * 1.8
};

/**
 * text-styles.ts's Treatment, widened with "none" — BuildOverrides.treatment
 * (in plan-beats.ts, a frozen interface) allows "none" to mean "drop this
 * beat's title".
 */
export type Treatment =
  /** Black text on a white box. The reviewed favourite. */
  | "boxLight"
  /** White text on a black box. */
  | "boxDark"
  /** White text with a hard black copy offset behind it — no blur. */
  | "hardShadow"
  /** No title for this beat. */
  | "none";

export interface Variant {
  font: FontKey;
  treatment: Treatment;
}

/**
 * The rotation. Leads with the combination that reviewed best (Coolvetica on a
 * white box) and alternates box/shadow so consecutive beats don't look alike.
 */
export const VARIANT_CYCLE: Variant[] = [
  { font: "coolvetica", treatment: "boxLight" },
  { font: "herkey", treatment: "hardShadow" },
  { font: "melodrame", treatment: "boxDark" },
  { font: "coolvetica", treatment: "hardShadow" },
];

/**
 * True when a beat's title sits directly on the footage with no box behind it,
 * and therefore needs a gradient scrim to guarantee contrast. Same predicate
 * as text-styles.ts:115.
 */
export function needsScrim(index: number, forced?: Treatment): boolean {
  return (forced ?? VARIANT_CYCLE[index % VARIANT_CYCLE.length]!.treatment) === "hardShadow";
}

/**
 * Resolves the whole variant, NOT just the treatment. VARIANT_CYCLE pairs a
 * font with each treatment, and the font drives BASE_SIZE and LINE_SPACING —
 * returning a bare treatment would silently drop the font rotation and render
 * every title in one typeface.
 * A forced treatment overrides the treatment only; the font still rotates.
 */
export function variantForIndex(index: number, forced?: Treatment): Variant {
  const cycled = VARIANT_CYCLE[index % VARIANT_CYCLE.length]!;
  return { font: cycled.font, treatment: forced ?? cycled.treatment };
}

/**
 * Splits a phrase into display lines of roughly `perLine` words, so a title
 * breaks where a person would rather than wherever the box runs out. Respects
 * explicit newlines the script author wrote.
 */
export function splitLines(text: string, perLine = 3): string[] {
  if (text.includes("\n")) return text.split("\n").map((l) => l.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= perLine) return [words.join(" ")];

  const lineCount = Math.ceil(words.length / perLine);
  const size = Math.ceil(words.length / lineCount);
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    lines.push(words.slice(i, i + size).join(" "));
  }
  return lines;
}

/** Escapes `&`, `<`, `>`, `"` before any interpolation into composition HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The title element for one beat, or "" when the beat has no title. */
export function titleHtml(opts: {
  beatId: string;
  text: string | undefined;
  startS: number;
  durationS: number;
  variant: Variant;
}): string {
  const { beatId, text, startS, durationS, variant } = opts;
  if (!text || variant.treatment === "none") return "";

  const lines = splitLines(text)
    .map((line) => `<span class="title-line">${escapeHtml(line)}</span>`)
    .join("");

  return (
    `<div class="clip title title--${variant.treatment} font-${variant.font}" ` +
    `id="title-${escapeHtml(beatId)}" data-start="${startS}" data-duration="${durationS}">` +
    lines +
    `</div>`
  );
}

/** The <style> block for the whole composition. */
export function compositionCss(opts: { width: number; height: number; fontFaces: string }): string {
  const { width, height, fontFaces } = opts;

  const fontDecls = (Object.keys(FONTS) as FontKey[])
    .map(
      (key) =>
        `.font-${key} { font-family: "${FONTS[key]}", sans-serif; font-size: ${BASE_SIZE[key]}px; line-height: calc(1em + ${LINE_SPACING[key]}px); }`,
    )
    .join("\n    ");

  return `
    ${fontFaces}

    body { margin: 0; }

    #root {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      background: #000;
    }

    .clip { position: absolute; inset: 0; }

    .beat-video { width: 100%; height: 100%; object-fit: cover; }

    /*
     * Scrim: only bare (unboxed) treatments sit directly on footage and need
     * a gradient behind them for contrast — see needsScrim().
     *
     * Reproduces src/edit/scrim.ts's ffmpeg matte BY VALUE: alpha
     * 255 * max(0, 1 - Y/(H/2)) — fully opaque black at the TOP of the
     * frame, ramping linearly to fully transparent by MID-frame. Titles are
     * centred at 24% of frame height (TITLE_CENTER_Y), well inside that ramp;
     * darkening the bottom instead would add nothing behind the title and
     * would dim the caption zone at 72%, which captions never asked for (they
     * carry their own 3px black stroke).
     */
    .scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        to bottom,
        rgba(0, 0, 0, 1) 0%,
        rgba(0, 0, 0, 0) 50%
      );
      pointer-events: none;
    }

    /*
     * Title vertical placement, CALIBRATED TO PALMIER.
     *
     * This used to be an inset box (top 10% / bottom 25%) with its content
     * flex-centred, which put the title's centre at ~42% of frame height. The
     * Task 8 parity render measured Palmier's titles far higher — the glyph
     * bounding box centred at 0.2370 of frame height on why_it_matters and
     * 0.2456 on hook, i.e. TITLE_CENTER_Y below. At 42% the title also sat on
     * top of the generated diagram's middle node on what_is.
     *
     * Anchoring the CENTRE (top + translateY(-50%)) rather than the top keeps
     * that measured position regardless of how many lines the title wraps to.
     * bottom:auto releases .clip's inset:0, which would otherwise stretch
     * this box to the full frame and re-centre the content.
     *
     * Clearance, at the largest case (three lines of Mélodrame at 122px):
     * box is ~17% of frame tall, so it spans 15.5%..32.5% — inside
     * SAFE_AREA.topClear (0.1) and nowhere near the caption band at 72%.
     */
    .title {
      position: absolute;
      left: 0;
      right: 0;
      top: ${round4(TITLE_CENTER_Y * 100)}%;
      bottom: auto;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 40px;
    }

    ${fontDecls}

    .title-line { display: block; white-space: pre-wrap; }

    /*
     * Box padding, radius and the hard-shadow offset are Palmier values and
     * scale with the type (PALMIER_SCALE) — a 1.8x larger word inside 16px of
     * padding reads as a different design, not the same one bigger.
     */
    .title--boxLight .title-line {
      color: #000000;
      background: #FFFFFF;
      border-radius: 18px;
      padding: 29px 54px;
    }

    .title--boxDark .title-line {
      color: #FFFFFF;
      background: #000000;
      border-radius: 18px;
      padding: 29px 54px;
    }

    .title--hardShadow .title-line {
      color: #FFFFFF;
      text-shadow: 7px 7px 0 #000000;
    }

    /*
     * One .caption-line is a timed clip spanning its words' first start to
     * last end (src/edit/captions.ts groups words into lines of <= 5). Each
     * .caption-word sits untimed inside it, so the whole line stays visible
     * for the line's duration; the active-word highlight is a timed
     * .caption-word__hl nested inside each word (a timed descendant of a
     * timed clip is fine — only <video data-start> nested in a timed
     * element is banned).
     */
    /*
     * bottom:auto and align-items:flex-start are LOAD-BEARING, and the Task 8
     * parity render is what proved it. .clip sets inset:0, so without
     * releasing bottom the line's box is 28% of frame TALL, and a flex
     * container's default align-items:stretch then makes every
     * .caption-word a full-height column. The active-word highlight is
     * position:absolute inset:0 inside that word, so it painted as a
     * 28%-tall red BAR down the frame on every caption in the video rather
     * than a plate behind one word. Height must come from the text.
     */
    /*
     * Caption size, CALIBRATED TO PALMIER. Measured on the full caption line
     * (white glyphs plus the red active-word plate, so the measurement does
     * not depend on WHICH word is highlighted) at why_it_matters @14.80s,
     * "since the release of v1.5":
     *   Palmier 541px wide   HyperFrames-at-31px 321px wide
     * The 12px inter-word gap below is OURS, not Palmier's (Palmier set a
     * text run with real spaces), and it does not scale with the type, so the
     * factor solves as (321 - 4*12) * k + 4*12 = 541 -> k = 1.806, i.e.
     * 31px -> 56px. That predicts a 539px line against Palmier's measured
     * 541px. Keep the gap at 12px: scaling it too overshoots to 579px.
     *
     * 72% is the line's CENTRE, not its top — that is what Palmier's
     * captionArgs() transform.y meant, and what captions.ts's centerY override
     * is named for. It only became visible once the type was calibrated: as a
     * top the taller line pushed the caption's measured centre to 0.7367 of
     * frame height against Palmier's 0.7195. translateY(-50%) makes the
     * declared number mean what it says at any font size or line count.
     */
    .caption-line {
      position: absolute;
      left: 0;
      right: 0;
      top: 72%;
      bottom: auto;
      transform: translateY(-50%);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      flex-wrap: wrap;
      gap: 0 12px;
      text-align: center;
      font-family: "${CAPTION_FONT}", sans-serif;
      font-size: 56px;
      color: #FFFFFF;
    }

    /*
     * Stroke scales with the type (PALMIER_SCALE): 3px was Palmier's value in
     * its reference space, and a 3px outline on 56px text is a hairline where
     * Palmier's read as a solid edge.
     */
    .caption-word {
      position: relative;
      display: inline-block;
      white-space: nowrap;
      -webkit-text-stroke: 5px #000000;
      paint-order: stroke fill;
    }

    /*
     * The highlight is a timed clip nested inside the (untimed) word, sized
     * to cover it exactly and shown only for that word's own window — so it
     * reads as the word switching color/background, not as a second word.
     */
    .caption-word__hl {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      -webkit-text-stroke: 3px #000000;
      paint-order: stroke fill;
    }

    .caption-word__hl--block {
      background: #E11D2E;
      -webkit-text-stroke: 0;
    }

    .caption-word__hl--pop {
      color: #FDE047;
      -webkit-text-stroke: 0;
    }
  `;
}
