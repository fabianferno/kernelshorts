import { framesToSeconds, roundSeconds } from "./units.js";
import { escapeHtml } from "./styles.js";

/**
 * Captions from word timings.
 *
 * kernelshorts' script produced the voiceover (TTS from `beat.vo_text`), so
 * the WORDS spoken in a beat are known with certainty before the audio ever
 * exists. Only the per-word TIMINGS are unknown until the transcriber (or
 * whatever aligner) measures the rendered VO file. Palmier could not express
 * that distinction: it transcribed the audio with ASR and had to guess at
 * words we already knew, so `src/edit/correct-captions.ts` existed purely to
 * rewrite the transcription back onto the script after the fact. That module
 * is gone — `alignWords` below always emits the script's tokens, never the
 * transcriber's, so a misheard word can no longer reach the render.
 *
 * DOM shape (matches the tuned Palmier `captionArgs()` in text-styles.ts,
 * which this preserves by value — maxWords 5, y 0.72, 56px (post-PALMIER_SCALE;
 * Palmier's own reference value was 31px), white with a 5px black stroke
 * (also post-PALMIER_SCALE; Palmier's was 3px), and a "block"/"pop"
 * active-word highlight):
 *
 *   Words are grouped into LINES of at most 5. Each line is ONE timed
 *   `<div class="clip caption-line">`, spanning from its first word's start
 *   to its last word's end, so the line reads and holds together on screen.
 *   Inside a line, each word is an UNTIMED `<span class="caption-word">`,
 *   visible for the whole line. The active-word highlight is a TIMED
 *   `<span class="caption-word__hl">` nested inside the word, carrying that
 *   word's own [startS, endS) window and sized to sit exactly over the
 *   word — so only the highlight (not the word's visibility) is timed. A
 *   timed element may be nested inside another timed clip; that is only
 *   banned for `<video data-start>`.
 */

export interface WordTiming {
  word: string;
  startS: number;
  endS: number;
}

export type CaptionHighlight = "block" | "pop";

const MAX_WORDS_PER_LINE = 5;

/**
 * Aligns known words (tokenized from `voText`) to timings measured from the
 * beat's own VO file. The output words always come from `voText` — `timings`
 * contributes windows only, positionally, never text.
 *
 * - Fewer timings than words: the remaining words are distributed evenly
 *   across the span from the last known timing's end to `voDurationS`.
 * - No timings at all: all words are distributed evenly across
 *   `voDurationS`.
 *
 * Guarantees: output length === word count, every window is non-empty,
 * windows are monotonic, and nothing exceeds `voDurationS`.
 */
export function alignWords(voText: string, timings: WordTiming[], voDurationS: number): WordTiming[] {
  const words = voText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const result: WordTiming[] = [];
  const known = Math.min(timings.length, words.length);

  for (let i = 0; i < known; i++) {
    const t = timings[i]!;
    const startS = t.startS;
    // Never let a known timing's end exceed the measured duration.
    const endS = Math.min(Math.max(t.endS, startS + 1e-6), voDurationS);
    result.push({ word: words[i]!, startS, endS });
  }

  const remaining = words.length - known;
  if (remaining > 0) {
    const spanStart = known > 0 ? result[known - 1]!.endS : 0;
    const spanEnd = voDurationS;
    const span = Math.max(spanEnd - spanStart, 0);
    const step = span / remaining;
    for (let i = 0; i < remaining; i++) {
      const startS = spanStart + step * i;
      const endS = i === remaining - 1 ? spanEnd : spanStart + step * (i + 1);
      result.push({
        word: words[known + i]!,
        startS,
        endS: Math.max(endS, startS + 1e-9),
      });
    }
  }

  // Guarantee monotonicity and the duration ceiling even if upstream timings
  // were noisy (e.g. a known timing's start regressed past the prior word's
  // end, or an endpoint landed marginally beyond voDurationS).
  for (let i = 0; i < result.length; i++) {
    const w = result[i]!;
    if (i > 0 && w.startS < result[i - 1]!.endS) {
      w.startS = result[i - 1]!.endS;
    }
    if (w.endS > voDurationS) w.endS = voDurationS;
    if (w.endS <= w.startS) w.endS = Math.min(w.startS + 1e-6, voDurationS);
    if (w.endS <= w.startS) {
      // voDurationS itself is ~0; fall back to a zero-width-safe epsilon
      // window that still satisfies endS > startS in floating point.
      w.startS = Math.max(0, voDurationS - 1e-6);
      w.endS = voDurationS;
    }
  }

  return result;
}

/** Groups aligned words into lines of at most `MAX_WORDS_PER_LINE`. */
function groupIntoLines(words: WordTiming[]): WordTiming[][] {
  const lines: WordTiming[][] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS_PER_LINE) {
    lines.push(words.slice(i, i + MAX_WORDS_PER_LINE));
  }
  return lines;
}

/**
 * Renders the caption track for one beat: lines of at most 5 words, each
 * line a timed clip, each word inside it untimed, each word carrying a
 * nested timed highlight span. Timings are rebased onto the beat's global
 * timeline via `framesToSeconds(startFrame)`.
 */
export function captionsHtml(opts: {
  beatId: string;
  startFrame: number;
  words: WordTiming[];
  centerY?: number;
  fontSize?: number;
  highlight?: CaptionHighlight;
}): string {
  const { beatId, startFrame, words, centerY, fontSize, highlight = "block" } = opts;
  const beatStartS = framesToSeconds(startFrame);

  const styleParts: string[] = [];
  // captionCenterY is a FRACTION (0-1), mirroring Palmier's captionArgs()
  // transform.y (e.g. 0.72) — convert to a CSS percentage here, not before.
  // `.caption-line` carries translateY(-50%), so this `top` really is the
  // line's CENTRE, which is what transform.y meant and what the name says.
  if (centerY !== undefined) styleParts.push(`top: ${centerY * 100}%`);
  if (fontSize !== undefined) styleParts.push(`font-size: ${fontSize}px`);
  const styleAttr = styleParts.length > 0 ? ` style="${styleParts.join("; ")}"` : "";

  const lines = groupIntoLines(words);
  let wordIndex = 0;

  const lineHtml = lines
    .map((line, lineIdx) => {
      if (line.length === 0) return "";
      // Rounded through units.ts: seconds-space addition reintroduces float
      // noise that would otherwise land in the HTML as 3.0000000000000004.
      const lineStartS = roundSeconds(beatStartS + line[0]!.startS);
      const lineEndS = roundSeconds(beatStartS + line[line.length - 1]!.endS);
      const lineDurationS = roundSeconds(lineEndS - lineStartS);

      const wordSpans = line
        .map((w) => {
          const i = wordIndex++;
          const hlStartS = roundSeconds(beatStartS + w.startS);
          const hlDurationS = roundSeconds(w.endS - w.startS);
          const escaped = escapeHtml(w.word);
          return (
            `<span class="caption-word" id="cap-${beatId}-${i}">` +
            `<span class="caption-word__hl caption-word__hl--${highlight}" ` +
            `data-start="${hlStartS}" data-duration="${hlDurationS}">${escaped}</span>` +
            escaped +
            `</span>`
          );
        })
        .join("\n");

      return (
        `<div class="clip caption-line" id="cap-line-${beatId}-${lineIdx}" ` +
        `data-start="${lineStartS}" data-duration="${lineDurationS}"${styleAttr}>` +
        wordSpans +
        `</div>`
      );
    })
    .join("\n");

  return lineHtml;
}
