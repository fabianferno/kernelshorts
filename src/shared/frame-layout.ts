/**
 * Fixed regions of the 1080x1920 studio frame, in pixels — ONE source for the
 * compositor (edit/studio.ts: captions, footnote) and the generated scenes
 * (assets/generated/page.ts: counter, tag, where a 3D prop may sit). A 3D
 * prop framed under the captions (2026-11-06) happened because page.ts kept
 * its own copy of where the captions were; move a caption here and the prop
 * band moves with it.
 */
export const FRAME = { width: 1080, height: 1920 } as const;

/**
 * What the PLATFORM draws over the video. Measured from a posted Reel
 * (2026-11-06, 19.5:9 iPhone): the status bar and the "Reels · Friends" tab
 * row cover y < ~260 of the 1920 frame, and the phone's taller aspect crops
 * ~47 px off each side. Captions at y 196 sat under the tabs; the brand and
 * the "?" badge were cut at the edges. Nothing that must be read goes there.
 */
export const PLATFORM_SAFE = { top: 272, side: 64 } as const;

/** Brand · chapter pill · badge row, just below the platform's header. */
export const CHROME = { top: PLATFORM_SAFE.top + 8, height: 72, side: PLATFORM_SAFE.side + 16 } as const;

export const CAPTION = {
  top: CHROME.top + CHROME.height + 16,
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

/** Moved down from 1236 when the top stack moved below the platform header,
 *  to give props back some room; still above the host's head (~y 1430). */
export const FOOTNOTE_TOP = 1290;
export const FOOTNOTE_LEFT = PLATFORM_SAFE.side + 16;

/** Framed card for footage / stills: between the captions and the footnote. */
export const STAGE_CARD = { top: CAPTION_BOTTOM + 24, bottom: FOOTNOTE_TOP - 24, side: 56 } as const;

/** The big ticking number of a prop3d scene, and the pill naming the prop. */
export const COUNTER = { top: CAPTION_BOTTOM + 2, bottom: CAPTION_BOTTOM + 222 } as const;
export const TAG = { height: 64, topWithCounter: COUNTER.bottom + 16, topAlone: CAPTION_BOTTOM + 72 } as const;

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
