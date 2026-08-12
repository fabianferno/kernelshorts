import type { AddTextEntry, TextStyle } from "../palmier/client.js";

/**
 * Overlay text styling — the on-screen titles, NOT the spoken captions.
 *
 * The first M1 export used white text with a soft drop shadow, which vanished
 * over the near-white Hacker News page. Every treatment here therefore carries
 * its own contrast (a plate, an outline, or a glow) rather than relying on the
 * footage behind it being dark.
 *
 * A variant pairs a font with a treatment, and variants cycle per beat so one
 * short doesn't repeat a single look while staying coherent in size and rhythm.
 */

/**
 * Fonts are installed to ~/Library/Fonts and kept in vault/fonts/. Palmier
 * matches on the family name EXACTLY — including the accent in "mélodrame" and
 * the "FREE VERSION" suffix Butler's free release carries. All five were
 * rendered live and confirmed before being listed here.
 *
 * LICENCES — only Butler is safe to publish with:
 *   Butler ................... 100% Free (commercial use OK)
 *   Relationship of Mélodrame  personal use only — Sizimon
 *   Herkey ................... personal use only — HansCo
 *   Coolvetica ............... personal use only — Typodermic
 *   The Magic Castle ......... personal use only — BlackFridayFont (€2 commercial)
 * See vault/fonts/<font>/LICENSE.md. Publishing a monetized or branded channel
 * with the personal-use faces needs a paid licence first.
 */
export const FONTS = {
  melodrame: "relationship of mélodrame",
  herkey: "Herkey",
  coolvetica: "Coolvetica",
  magicCastle: "The Magic Castle",
  butler: "Butler FREE VERSION",
} as const;

export type FontKey = keyof typeof FONTS;

/**
 * Per-font base size, in px at 1080x1920.
 *
 * Not cosmetic bikeshedding: these faces have very different metrics, and at a
 * shared 70px Mélodrame set two tidy lines while the other four wrapped to four
 * lines and overflowed the frame. Sizes below were set by rendering the same
 * phrase in each face and matching their optical size.
 */
const BASE_SIZE: Record<FontKey, number> = {
  melodrame: 68,
  herkey: 46,
  coolvetica: 44,
  magicCastle: 44,
  butler: 50,
};

/** Tight line height — these faces sprawl at default spacing. */
const LINE_SPACING = -18;

/**
 * Text transforms accept EITHER {centerX, centerY} for auto-fit OR all four of
 * {centerX, centerY, width, height} — passing width alone is rejected outright.
 * We auto-fit and control wrapping with explicit line breaks in splitLines(),
 * which gives better breaks than a box width would anyway.
 */
export type Treatment = "plate" | "glow" | "accent" | "mixed" | "clean";

export interface Variant {
  font: FontKey;
  treatment: Treatment;
}

/**
 * The rotation. Ordered so adjacent beats contrast — a bold sans plate is
 * followed by an airy serif glow, not by another heavy treatment.
 */
export const VARIANT_CYCLE: Variant[] = [
  { font: "coolvetica", treatment: "plate" },
  { font: "butler", treatment: "glow" },
  { font: "melodrame", treatment: "accent" },
  { font: "herkey", treatment: "mixed" },
  { font: "magicCastle", treatment: "clean" },
];

function baseStyle(font: FontKey, scale = 1): TextStyle {
  return {
    fontName: FONTS[font],
    alignment: "center",
    lineSpacing: LINE_SPACING,
    fontSize: Math.round(BASE_SIZE[font] * scale),
  };
}

function treatmentStyle(font: FontKey, treatment: Exclude<Treatment, "mixed">): TextStyle {
  switch (treatment) {
    case "plate":
      // Inverted card: dark text on light. Reads over any footage.
      return {
        ...baseStyle(font),
        color: "#101418",
        background: {
          enabled: true,
          color: "#FFFFFF",
          opacity: 0.95,
          cornerRadius: 14,
          padding: { x: 30, y: 16 },
        },
      };
    case "glow":
      // The outline is not decoration: a pale glow on white text disappears
      // completely over a light background (it vanished over the Hacker News
      // page in a real export). The dark keyline is what guarantees contrast;
      // the glow is the flourish on top of it.
      return {
        ...baseStyle(font, 1.05),
        color: "#FFFFFF",
        outline: { enabled: true, color: "#0B1220", width: 5 },
        shadow: {
          enabled: true,
          color: "#7DD3FC",
          opacity: 1,
          blur: 40,
          offset: { x: 0, y: 0 },
        },
      };
    case "accent":
      return {
        ...baseStyle(font),
        color: "#FDE047",
        outline: { enabled: true, color: "#000000", width: 6 },
      };
    case "clean":
      return {
        ...baseStyle(font),
        color: "#FFFFFF",
        outline: { enabled: true, color: "#000000", width: 5 },
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
 * Most treatments are a single clip. "mixed" emits one clip per line at
 * alternating sizes and colours — Palmier applies one style per text clip, so
 * varying size within a phrase means stacking clips and positioning them by
 * hand.
 */
export function buildOverlay(opts: OverlayOptions): AddTextEntry[] {
  const { text, startFrame, endFrame, index } = opts;
  const centerY = opts.centerY ?? 0.24;
  const variant = VARIANT_CYCLE[index % VARIANT_CYCLE.length]!;
  const { font, treatment } = variant;

  if (treatment !== "mixed") {
    return [
      {
        content: splitLines(text).join("\n"),
        startFrame,
        endFrame,
        animation: "slideUp",
        transform: { centerX: 0.5, centerY },
        style: treatmentStyle(font, treatment),
      },
    ];
  }

  // Mixed sizes: alternate emphasis line by line, stacked around centerY.
  // The step must clear the LARGER of the two sizes or the lines collide —
  // the first attempt used 0.055 and the big line overlapped its neighbour.
  const lines = splitLines(text, 2);
  const step = 0.075;
  const top = centerY - ((lines.length - 1) * step) / 2;

  return lines.map((line, i) => ({
    content: line,
    startFrame,
    endFrame,
    animation: "slideUp" as const,
    transform: { centerX: 0.5, centerY: top + i * step },
    style: {
      ...baseStyle(font, i % 2 === 0 ? 0.85 : 1.25),
      color: i % 2 === 0 ? "#FFFFFF" : "#FDE047",
      outline: { enabled: true, color: "#000000", width: 5 },
    },
  }));
}

/**
 * Caption styling for the spoken word track.
 *
 * Smaller and mixed-case (the first pass was 64px uppercase, which shouted),
 * with the currently-spoken word highlighted so captions read as karaoke rather
 * than as a subtitle block. Both treatments were rendered and compared:
 *   - "pop"   — active word turns yellow. Cleaner over busy footage.
 *   - "block" — active word gets a red plate. Punchier, heavier.
 */
export type CaptionHighlight = "pop" | "block";

export function captionArgs(highlight: CaptionHighlight = "pop") {
  return {
    maxWords: 5,
    // Keep clear of platform UI: bottom ~25% and top 10% (PRD §5).
    transform: { centerX: 0.5, centerY: 0.66 },
    animation: highlight === "pop" ? ("highlightPop" as const) : ("highlightBlock" as const),
    highlightColor: highlight === "pop" ? "#FDE047" : "#EF4444",
    style: {
      fontSize: 52,
      bold: true,
      color: "#FFFFFF",
      fontCase: "mixed" as const,
      outline: { enabled: true, color: "#000000", width: 5 },
    },
  };
}
