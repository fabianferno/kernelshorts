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
 * Per-font base size, in px at 1080x1920.
 *
 * These faces have very different metrics: at a shared 70px Mélodrame set two
 * tidy lines while the others wrapped to four and overflowed. Sizes were set by
 * rendering the same phrase in each face and matching their optical size.
 */
const BASE_SIZE: Record<FontKey, number> = {
  coolvetica: 44,
  herkey: 46,
  melodrame: 68,
};

/**
 * Line height per font. Tight spacing keeps these display faces compact, but
 * the right amount is per-face: at a shared −18 Herkey's two lines physically
 * collided (its ascenders are tall), while Mélodrame still looked airy.
 */
const LINE_SPACING: Record<FontKey, number> = {
  coolvetica: -14,
  herkey: 2,
  melodrame: -18,
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
     */
    .scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0) 0%,
        rgba(0, 0, 0, 0.55) 100%
      );
      pointer-events: none;
    }

    /*
     * Title vertical placement respects SAFE_AREA (src/verify/timeline.ts):
     * topClear 0.1, bottomClear 0.25 — titles sit between those bounds.
     */
    .title {
      position: absolute;
      left: 0;
      right: 0;
      top: 10%;
      bottom: 25%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 40px;
    }

    ${fontDecls}

    .title-line { display: block; white-space: pre-wrap; }

    .title--boxLight .title-line {
      color: #000000;
      background: #FFFFFF;
      border-radius: 10px;
      padding: 16px 30px;
    }

    .title--boxDark .title-line {
      color: #FFFFFF;
      background: #000000;
      border-radius: 10px;
      padding: 16px 30px;
    }

    .title--hardShadow .title-line {
      color: #FFFFFF;
      text-shadow: 4px 4px 0 #000000;
    }

    /*
     * One .caption-line is a timed clip spanning its words' first start to
     * last end (src/edit/captions.ts groups words into lines of <= 5). Each
     * .caption-word sits untimed inside it, so the whole line stays visible
     * for the line's duration; the active-word highlight is a timed
     * .caption-word__hl nested inside each word (a timed descendant of a
     * timed clip is fine — only a video element carrying data-start nested
     * in a timed element is banned).
     */
    .caption-line {
      position: absolute;
      left: 0;
      right: 0;
      top: 72%;
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 0 12px;
      text-align: center;
      font-family: "${CAPTION_FONT}", sans-serif;
      font-size: 31px;
      color: #FFFFFF;
    }

    .caption-word {
      position: relative;
      display: inline-block;
      white-space: nowrap;
      -webkit-text-stroke: 3px #000000;
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
