/**
 * Shared look for every generated scene.
 *
 * These sit in the same cut as real footage and stock B-roll, so they have to
 * read as the same channel: the display face is Coolvetica (the same family the
 * overlay titles use, see edit/text-styles.ts) and the accent red is the exact
 * caption-highlight red (#E11D2E) so a generated beat next to a captioned beat
 * shares a colour.
 *
 * FONTS ARE LOCAL ONLY. Headless Chromium on this Mac resolves
 * ~/Library/Fonts through CoreText, so `font-family: Coolvetica` works with no
 * @font-face and no network. Confirmed installed: CoolveticaRg.otf,
 * HerkeyTTF.ttf, SFNSMono.ttf, Menlo.ttc.
 */
export const THEME = {
  /**
   * Dark, but deliberately NOT near-black. At #080B10 the entire frame sat
   * under blackdetect's pixel threshold and ffmpeg reported a real render as
   * one long black segment (measured: black_start:0.64 black_end:5.12). A base
   * luma around 30 keeps every frame legitimately "not black" while still
   * reading as a dark scene next to real footage.
   */
  bg: "#16202E",
  bgLift: "#1E2B3D",
  panel: "#0C131C",
  panelEdge: "#2E4055",
  text: "#E9F0F7",
  textDim: "#8CA0B3",
  accent: "#E11D2E",
  cyan: "#4CC2FF",
  green: "#3DDC91",
  amber: "#FFB84C",
  display: `Coolvetica, "Helvetica Neue", Helvetica, Arial, sans-serif`,
  mono: `"SF Mono", Menlo, ui-monospace, monospace`,
} as const;

/**
 * Vertical safe bands at 1080x1920 (PRD §5 caption safe area).
 *
 * Captions are centred at 0.72 (y≈1382) and overlay titles at 0.24 (y≈460), so
 * scene content lives between them: y 560..1180. Anything a viewer must read
 * goes inside that window; decoration may bleed outside it.
 */
export const SAFE = {
  contentTop: 560,
  contentBottom: 1180,
  /** Left/right margin. 80px reads as a real margin on a phone; 40 does not. */
  margin: 80,
} as const;
