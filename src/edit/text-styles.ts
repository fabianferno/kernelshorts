import type { AddTextEntry, TextStyle } from "../palmier/client.js";

/**
 * Overlay text styling — the on-screen titles, NOT the spoken captions.
 *
 * The palette here is deliberately narrow. An earlier pass offered glow,
 * yellow-accent and outlined treatments across five faces; reviewed against
 * real exports, only the box treatments held up, so the rest were cut rather
 * than kept as options nobody would pick.
 *
 * Hard rules, from review:
 *   - No black stroke/outline on overlay text, ever.
 *   - Contrast comes from a box or an offset hard shadow, never from a glow.
 *   - Three fonts only: Coolvetica, Herkey, Relationship of Mélodrame.
 */

/**
 * Fonts are installed to ~/Library/Fonts and kept in vault/fonts/. Palmier
 * matches the name EXACTLY — including the accent in "mélodrame". All were
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
 * alone gets you the upright). Palmier is given the full name.
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
 * Text transforms accept EITHER {centerX, centerY} for auto-fit OR all four of
 * {centerX, centerY, width, height} — passing width alone is rejected outright.
 * We auto-fit and control wrapping with explicit line breaks in splitLines().
 */

export type Treatment =
  /** Black text on a white box. The reviewed favourite. */
  | "boxLight"
  /** White text on a black box. */
  | "boxDark"
  /** White text with a hard black copy offset behind it — no blur. */
  | "hardShadow";

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

function baseStyle(font: FontKey, scale = 1): TextStyle {
  return {
    fontName: FONTS[font],
    alignment: "center",
    lineSpacing: LINE_SPACING[font],
    fontSize: Math.round(BASE_SIZE[font] * scale),
  };
}

function treatmentStyle(font: FontKey, treatment: Treatment): TextStyle {
  switch (treatment) {
    case "boxLight":
      return {
        ...baseStyle(font),
        color: "#000000",
        background: {
          enabled: true,
          color: "#FFFFFF",
          opacity: 1,
          cornerRadius: 10,
          padding: { x: 30, y: 16 },
        },
      };
    case "boxDark":
      return {
        ...baseStyle(font),
        color: "#FFFFFF",
        background: {
          enabled: true,
          color: "#000000",
          opacity: 1,
          cornerRadius: 10,
          padding: { x: 30, y: 16 },
        },
      };
    case "hardShadow":
      // A hard shadow, not a soft one: zero blur and a visible offset, so it
      // reads as an offset duplicate of the letterform rather than a halo.
      return {
        ...baseStyle(font),
        color: "#FFFFFF",
        shadow: {
          enabled: true,
          color: "#000000",
          opacity: 1,
          blur: 0,
          offset: { x: 7, y: 7 },
        },
      };
  }
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

export interface OverlayOptions {
  text: string;
  startFrame: number;
  endFrame: number;
  /** Beat index — selects the variant, so the look cycles through the video. */
  index: number;
  /** Vertical centre of the block, 0–1. */
  centerY?: number;
}

/**
 * Builds the text clips for one beat's on-screen title.
 *
 * Returns one entry per stacked LAYER. Callers must place each layer on its own
 * track: clips sharing a track are sequential, so two text clips with the same
 * frame range on one track silently overwrite each other.
 */
export function buildOverlay(opts: OverlayOptions): AddTextEntry[] {
  const { text, startFrame, endFrame, index } = opts;
  const centerY = opts.centerY ?? 0.24;
  const variant = VARIANT_CYCLE[index % VARIANT_CYCLE.length]!;

  return [
    {
      content: splitLines(text).join("\n"),
      startFrame,
      endFrame,
      animation: "slideUp",
      transform: { centerX: 0.5, centerY },
      style: treatmentStyle(variant.font, variant.treatment),
    },
  ];
}

/**
 * Caption styling for the spoken word track.
 *
 * Set in Coolvetica Italic and small — 31px, down ~40% from the first pass,
 * which read as a subtitle slab across the frame. The active word gets a red
 * plate with white text so captions play as karaoke, landing each word exactly
 * when it is spoken.
 */
export type CaptionHighlight = "block" | "pop";

export function captionArgs(highlight: CaptionHighlight = "block") {
  return {
    maxWords: 5,
    // Keep clear of platform UI: bottom ~25% and top 10% (PRD §5).
    transform: { centerX: 0.5, centerY: 0.66 },
    animation: highlight === "block" ? ("highlightBlock" as const) : ("highlightPop" as const),
    highlightColor: highlight === "block" ? "#E11D2E" : "#FDE047",
    style: {
      fontName: CAPTION_FONT,
      fontSize: 31,
      color: "#FFFFFF",
      fontCase: "mixed" as const,
      // Captions sit over unpredictable footage and are far smaller than the
      // titles, so they keep a thin keyline. The no-stroke rule is for the
      // overlay titles, where the box or hard shadow does that job instead.
      outline: { enabled: true, color: "#000000", width: 4 },
    },
  };
}
