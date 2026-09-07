import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config.js";
import type { WordTiming } from "./captions.js";

/**
 * Word timings for a voiceover clip, from a hosted whisper.cpp server.
 *
 * ---------------------------------------------------------------------------
 * WHY A HOSTED SERVER
 * ---------------------------------------------------------------------------
 * This replaces `hyperframes transcribe`, which ran whisper.cpp locally and
 * downloaded a 487 MB model on first use. Nothing is downloaded now, and no
 * local CPU is spent decoding audio. The trade is a network dependency — an
 * acceptable one, because a transcription failure is already non-fatal: it
 * degrades that beat to evenly distributed timings with a loud warning
 * (`wordTimingsForBeat` in build.ts) rather than stopping the video.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL (observed against the live server on 2026-09-07, not guessed)
 * ---------------------------------------------------------------------------
 * POST <WHISPER_URL>/inference, multipart/form-data:
 *     file=@<audio>, temperature=0.0, response_format=verbose_json
 *
 * `verbose_json` is the ONLY format that carries per-word timings; `json`
 * returns the transcript text alone, which is useless here — we already know
 * the words, we need to know *when* they are said.
 *
 * Response shape:
 *   { task, language, duration, text,
 *     segments: [ { id, text, start, end, tokens,
 *                   words: [ { word, start, end, probability }, ... ] } ] }
 *
 * Note the words are nested per segment (flatten across all segments), the
 * fields are `start`/`end` rather than this codebase's `startS`/`endS`, and
 * every word carries a LEADING SPACE (" Imagine", " a").
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOKENS MUST BE MERGED — the defect this module exists to prevent
 * ---------------------------------------------------------------------------
 * Whisper tokenizes more finely than the script does. Measured on the `hook`
 * beat of run 2026-08-18: 19 whisper tokens against 14 script words, because
 * whisper splits contractions ("that's" -> " that" + "'s") and emits bare
 * punctuation (".") as tokens of its own.
 *
 * `alignWords` (captions.ts) pairs script words to timings POSITIONALLY, so
 * feeding it the raw token list silently desynchronises every caption after
 * the first contraction, and the drift compounds toward the end of the beat.
 * On that beat, script word 4 ("40") would have been timed to the token "'s".
 *
 * So the tokens are reconciled back onto the script's own words before they
 * leave this module. The script remains the sole source of the WORDS — as it
 * must, since the script is what produced the audio — and whisper contributes
 * only the timings, which is the entire division of labour that let
 * `correct-captions.ts` be deleted.
 */

/** One word as the whisper.cpp server reports it. */
interface WhisperToken {
  word: string;
  start: number;
  end: number;
}

interface WhisperResponse {
  segments?: Array<{ words?: WhisperToken[] }>;
}

/**
 * Comparison key: letters and digits only, lowercased.
 *
 * Punctuation has to go because whisper attaches it inconsistently (" query"
 * then "." separately, but sometimes " new." as one token), and case has to go
 * because whisper capitalises sentence starts the script may not.
 */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Similarity between a script word and a whisper token, both already keyed.
 *
 * Prefix scores highly because that is the shape a contraction split takes:
 * "that's" against " that". A mismatch is only mildly negative — cheaper than
 * the two gaps it would otherwise cost — so the aligner prefers to pair a
 * misheard word with the audio that produced it rather than orphan both.
 */
function score(a: string, b: string): number {
  if (a === b) return 3;
  if (a.startsWith(b) || b.startsWith(a)) return 2;
  return -1;
}

const GAP = -1;

/**
 * Folds whisper's tokens onto the script's words by sequence alignment.
 *
 * Needleman-Wunsch over the normalised keys, then every token is attributed to
 * a script word and each word takes the window spanning its tokens.
 *
 * WHY NOT SOMETHING SIMPLER. A greedy left-to-right merge handles contractions
 * and nothing else, because it cannot recover from an INSERTION — whisper
 * hearing more words than were spoken. Measured on the `what_is` beat of run
 * 2026-08-18, where the server returns 18 tokens for 11 script words:
 *
 *     script:  DuckDB          version 2.0    is named Cyanoptera     after ...
 *     whisper: The / only / V  version 2/./0  is named Sin/op/tera    after ...
 *
 * "DuckDB" is heard as three tokens that share no prefix with it. A greedy
 * pass consumes one token per word from there on and never catches up, so
 * every caption in the beat lands about three words early — roughly two
 * seconds of visible desync, on one beat in six.
 *
 * Alignment recovers, because "version", "is", "named" and everything from
 * "after" onward still match exactly and act as anchors: the damage stays
 * local to the misheard word instead of propagating to the end of the beat.
 *
 * Tokens the alignment could not pair (whisper's extra syllables) attach to
 * the word they neighbour, so "Cyanoptera" still spans Sin+op+tera. Script
 * words the alignment could not pair get a window interpolated from their
 * neighbours, so no word is left without a time.
 *
 * Punctuation-only tokens normalise to "" and are dropped before aligning.
 *
 * Returns at most `scriptWords.length` timings, and fewer when the tokens run
 * out before the words do — `alignWords` already spreads the remainder across
 * the measured duration, which is specified fallback behaviour rather than a
 * silent degrade. Inventing a timing here would be a fabrication.
 */
export function mergeToScriptWords(
  scriptWords: string[],
  tokens: WhisperToken[],
): WordTiming[] {
  const usable = tokens.filter((t) => norm(t.word) !== "");
  if (scriptWords.length === 0 || usable.length === 0) return [];

  const keys = scriptWords.map(norm);
  const toks = usable.map((t) => norm(t.word));
  const n = keys.length;
  const m = toks.length;

  // Score matrix. dp[i][j] is the best score aligning the first i words
  // against the first j tokens.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i]![0] = i * GAP;
  for (let j = 1; j <= m; j++) dp[0]![j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = Math.max(
        dp[i - 1]![j - 1]! + score(keys[i - 1]!, toks[j - 1]!),
        dp[i - 1]![j]! + GAP, // script word with no token of its own
        dp[i]![j - 1]! + GAP, // token whisper added
      );
    }
  }

  // Traceback, collecting the tokens each script word owns.
  const owned: number[][] = Array.from({ length: n }, () => []);
  const unpaired: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    // Ties are broken toward consuming the TOKEN, which walks backwards over a
    // run of equally-scoring tokens and pairs the word with the FIRST of them.
    // That matters when whisper splits a word into syllables: pairing
    // "Cyanoptera" with "Sin" lets "op" and "tera" attach to it below, whereas
    // pairing with "tera" would strand the first two on the preceding word and
    // report the caption 0.6s late. Only genuinely tied paths are affected —
    // the branch is taken solely when it equals the optimum.
    if (i > 0 && j > 0 && dp[i]![j] === dp[i]![j - 1]! + GAP) {
      unpaired.push(j - 1);
      j--;
    } else if (
      i > 0 && j > 0 &&
      dp[i]![j] === dp[i - 1]![j - 1]! + score(keys[i - 1]!, toks[j - 1]!)
    ) {
      owned[i - 1]!.push(j - 1);
      i--;
      j--;
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + GAP) {
      i--;
    } else {
      unpaired.push(j - 1);
      j--;
    }
  }

  // Attach each unpaired token to the nearest word that did claim one, preferring
  // the word before it — whisper's extra syllables belong to the word it was
  // in the middle of mishearing ("Sin"+"op"+"tera" -> "Cyanoptera").
  const ownerOfToken = new Array<number>(m).fill(-1);
  for (let w = 0; w < n; w++) for (const tk of owned[w]!) ownerOfToken[tk] = w;
  for (const tk of unpaired) {
    let owner = -1;
    for (let k = tk - 1; k >= 0; k--) if (ownerOfToken[k] !== -1) { owner = ownerOfToken[k]!; break; }
    if (owner === -1) {
      for (let k = tk + 1; k < m; k++) if (ownerOfToken[k] !== -1) { owner = ownerOfToken[k]!; break; }
    }
    if (owner !== -1) owned[owner]!.push(tk);
  }

  // A window per word, from the tokens it owns.
  const windows: Array<{ startS: number; endS: number } | undefined> = owned.map((tks) => {
    if (tks.length === 0) return undefined;
    return {
      startS: Math.min(...tks.map((k) => usable[k]!.start)),
      endS: Math.max(...tks.map((k) => usable[k]!.end)),
    };
  });

  // Words the alignment could not pair sit between words it could; give them
  // an even share of the silence between their neighbours. A trailing run with
  // nothing after it is dropped rather than invented.
  const lastPaired = windows.reduce((acc, w, idx) => (w ? idx : acc), -1);
  for (let w = 0; w <= lastPaired; w++) {
    if (windows[w]) continue;
    let prev = w - 1;
    while (prev >= 0 && !windows[prev]) prev--;
    let next = w + 1;
    while (next <= lastPaired && !windows[next]) next++;
    const from = prev >= 0 ? windows[prev]!.endS : 0;
    const to = windows[next]!.startS;
    const gapCount = next - (prev + 1);
    const slice = (to - from) / Math.max(gapCount, 1);
    const offset = w - (prev + 1);
    windows[w] = { startS: from + slice * offset, endS: from + slice * (offset + 1) };
  }

  const merged: WordTiming[] = [];
  for (let w = 0; w <= lastPaired; w++) {
    const win = windows[w]!;
    // Monotonic and non-empty: the caption highlight advances, never rewinds.
    const startS = Math.max(win.startS, merged.at(-1)?.startS ?? 0);
    merged.push({ word: scriptWords[w]!, startS, endS: Math.max(win.endS, startS) });
  }
  return merged;
}

/**
 * Transcribes one voiceover file and returns timings for the SCRIPT's words.
 *
 * `voText` is not optional and is not a hint: it is the ground truth the
 * returned words carry. Whisper's own transcript is never propagated.
 */
export async function transcribeVoiceover(
  voPath: string,
  voText: string,
): Promise<WordTiming[]> {
  const audio = await readFile(voPath);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio)]), basename(voPath));
  form.set("temperature", "0.0");
  form.set("response_format", "verbose_json");

  const url = `${config.whisperUrl.replace(/\/+$/, "")}/inference`;
  const res = await fetch(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`whisper ${url} answered ${res.status} ${res.statusText}`);
  }

  const parsed = (await res.json()) as WhisperResponse;
  const tokens = (parsed.segments ?? []).flatMap((s) => s.words ?? []);
  return mergeToScriptWords(voText.split(/\s+/).filter(Boolean), tokens);
}
