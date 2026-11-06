
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
 * Rendering the words on screen is studio.ts's job (captionGroups /
 * captionsStudioHtml); this module only decides WHICH words, WHEN.
 */

export interface WordTiming {
  word: string;
  startS: number;
  endS: number;
}

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
