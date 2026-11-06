/**
 * Base styles shared by every composition. The visual design itself — themed
 * backdrops, chrome, captions, host, footnotes — lives in studio.ts; this file
 * is only the canvas contract plus two shared constants.
 *
 * (The old "classic" Hacker-News layout — full-bleed footage, rotating title
 * treatments with scrims, lower-third captions — was removed on 2026-11-06;
 * see git history before that date for its Palmier-calibrated sizes.)
 */

/**
 * The studio caption font size in px at 1080x1920. Single source of truth:
 * studio.ts's `.cap` rule uses it, and the review loop reports it to the
 * vision reviewer (review/loop.ts resolveCaptionFontSize).
 */
export const CAPTION_FONT_SIZE = 68;

/** Text from scripts reaches the HTML only through this. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The canvas contract: a fixed-size root that clips its children, timed
 * clips absolutely positioned and full-bleed by default, footage covering.
 */
export function baseCss(width: number, height: number): string {
  return `
    body { margin: 0; }
    #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
    .clip { position: absolute; inset: 0; }
    .beat-video { width: 100%; height: 100%; object-fit: cover; }
  `;
}
