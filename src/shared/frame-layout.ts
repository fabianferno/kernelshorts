/**
 * Fixed regions of the 1080x1920 studio frame, in pixels — ONE source for the
 * compositor (edit/studio.ts: captions, footnote) and the generated scenes
 * (assets/generated/page.ts: counter, tag, where a 3D prop may sit). A 3D
 * prop framed under the captions (2026-11-06) happened because page.ts kept
 * its own copy of where the captions were; move a caption here and the prop
 * band moves with it.
 */
export const FRAME = { width: 1080, height: 1920 } as const;

export const CAPTION = {
  top: 196,
  minHeight: 110,
  fontSize: 68,
  lineHeight: 1.12,
  /** Groups are ≤3 words; budget for one wrapping onto a second line. */
  maxLines: 2,
} as const;

/** Lowest pixel a caption group can reach. */
export const CAPTION_BOTTOM = Math.round(
  CAPTION.top + Math.max(CAPTION.minHeight, CAPTION.maxLines * CAPTION.fontSize * CAPTION.lineHeight),
);

export const FOOTNOTE_TOP = 1236;

/** The big ticking number of a prop3d scene, and the pill naming the prop. */
export const COUNTER = { top: CAPTION_BOTTOM + 2, bottom: CAPTION_BOTTOM + 242 } as const;
export const TAG = { height: 64, topWithCounter: COUNTER.bottom + 22, topAlone: CAPTION_BOTTOM + 72 } as const;

/**
 * Vertical band (px) a 3D prop must fit inside: below whatever sits above it
 * (captions, counter, tag) with a margin, above the footnote.
 */
export function propBand(opts: { counter: boolean; tag: boolean }): { top: number; bottom: number } {
  const above = opts.tag
    ? (opts.counter ? TAG.topWithCounter : TAG.topAlone) + TAG.height
    : opts.counter ? COUNTER.bottom : CAPTION_BOTTOM;
  return { top: above + 16, bottom: FOOTNOTE_TOP - 36 };
}
