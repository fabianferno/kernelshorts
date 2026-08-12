import type { AddTextEntry, TextStyle } from "../palmier/client.js";

/**
 * Overlay text styling — the on-screen titles, NOT the spoken captions.
 *
 * The first M1 export used white text with a soft drop shadow, which vanished
 * over the near-white Hacker News page. Every variant here therefore carries
 * its own contrast (a plate, an outline, or a glow) rather than relying on the
 * footage behind it being dark.
 *
 * Variants cycle per beat so a single short doesn't repeat one look, while any
 * one video stays coherent because they share a family, a size range, and a
 * tight line height.
 */

/**
 * Installed to ~/Library/Fonts and kept in vault/fonts/. Palmier matches on the
 * family name exactly — including the accent, which is easy to lose in
 * copy/paste. Verified rendering live before being used here.
 *
 * LICENCE: personal use only (Sizimon). Commercial or promotional use requires
 * a paid licence — see vault/fonts/relationship-of-melodrame/LICENSE.md.
 */
export const DISPLAY_FONT = "relationship of mélodrame";

/** Tight line height: this face is airy, and the default spacing sprawls. */
const LINE_SPACING = -22;

export type OverlayVariant = "plate" | "glow" | "accent" | "mixed";

export const VARIANT_CYCLE: OverlayVariant[] = ["plate", "glow", "accent", "mixed"];

const BASE: TextStyle = {
  fontName: DISPLAY_FONT,
  alignment: "center",
  lineSpacing: LINE_SPACING,
};

/** Inverted plate: dark text on a light card. Reads over any footage. */
const plate: TextStyle = {
  ...BASE,
  fontSize: 64,
  color: "#101418",
  background: {
    enabled: true,
    color: "#FFFFFF",
    opacity: 0.95,
    cornerRadius: 14,
    padding: { x: 32, y: 16 },
  },
};

/** Cool glow: white text with a bloom that separates it from busy frames. */
const glow: TextStyle = {
  ...BASE,
  fontSize: 68,
  color: "#FFFFFF",
  shadow: { enabled: true, color: "#7DD3FC", opacity: 1, blur: 40, offset: { x: 0, y: 0 } },
};

/** Accent: warm yellow with a hard outline — the punchiest of the four. */
const accent: TextStyle = {
  ...BASE,
  fontSize: 66,
  color: "#FDE047",
  outline: { enabled: true, color: "#000000", width: 6 },
};

const VARIANT_STYLE: Record<Exclude<OverlayVariant, "mixed">, TextStyle> = {
  plate,
  glow,
  accent,
};

/**
 * Splits a phrase into display lines of roughly `perLine` words, so a title
 * wraps where a person would break it rather than wherever the box happens to
 * run out. Respects explicit newlines the script author wrote.
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
 * Most variants are a single clip. The "mixed" variant emits one clip per line
 * at alternating sizes — Palmier applies one style per text clip, so varying
 * size within a phrase means stacking clips and positioning them manually.
 */
export function buildOverlay(opts: OverlayOptions): AddTextEntry[] {
  const { text, startFrame, endFrame, index } = opts;
  const centerY = opts.centerY ?? 0.24;
  const variant = VARIANT_CYCLE[index % VARIANT_CYCLE.length]!;

  if (variant !== "mixed") {
    return [
      {
        content: splitLines(text).join("\n"),
        startFrame,
        endFrame,
        animation: "slideUp",
        transform: { centerX: 0.5, centerY },
        style: VARIANT_STYLE[variant],
      },
    ];
  }

  // Mixed sizes: emphasise alternating lines, stacked around centerY.
  const lines = splitLines(text, 2);
  const sizes = lines.map((_, i) => (i % 2 === 0 ? 58 : 86));
  // Normalised line height per clip; approximate but stable at 1080x1920.
  const step = 0.055;
  const top = centerY - ((lines.length - 1) * step) / 2;

  return lines.map((line, i) => ({
    content: line,
    startFrame,
    endFrame,
    animation: "slideUp" as const,
    transform: { centerX: 0.5, centerY: top + i * step },
    style: {
      ...BASE,
      fontSize: sizes[i]!,
      color: i % 2 === 0 ? "#FFFFFF" : "#FDE047",
      outline: { enabled: true, color: "#000000", width: 5 },
    },
  }));
}

/**
 * Caption styling for the spoken word track.
 *
 * Smaller and mixed-case (the first pass was 64px uppercase, which shouted),
 * with the currently-spoken word highlighted so the captions read as karaoke
 * rather than as a subtitle block. Both highlight treatments were rendered and
 * compared before choosing:
 *   - "pop"   — the active word turns yellow. Cleaner over busy footage.
 *   - "block" — the active word gets a red plate. Punchier, heavier.
 */
export type CaptionHighlight = "pop" | "block";

export function captionArgs(highlight: CaptionHighlight = "pop") {
  return {
    maxWords: 5,
    // Keep clear of the platform UI: bottom ~25% and top 10% (PRD §5).
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
