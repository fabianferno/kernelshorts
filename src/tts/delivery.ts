/**
 * Delivery markup: how a line is PERFORMED, written once in the script and
 * translated per TTS provider.
 *
 * Canonical syntax = Soniox's (docs.soniox.com/tts/concepts/emotion-and-tone,
 * read 2026-11-06), the richest of the three:
 *   [excited] INCREDIBLE news! [calm] Let me explain.     ← tags before the words they colour
 *   that was *never* the plan                              ← *stress* one word
 *   [pause] / [long pause]                                 ← beats of silence
 *   sooo · I-I-I don't… · — · ?!                           ← plain-text expression
 *
 * Per provider:
 *   soniox     gets it verbatim (tts-rt-v2 performs all of it)
 *   sarvam     no tag syntax exists for Bulbul (checked docs, blog, SDK 1.1.15
 *              on 2026-11-06): tags become punctuation (Sarvam's documented
 *              controls: "!" emphasis, "…" hesitation, "," short pause);
 *              expressiveness comes from the persona + `temperature`
 *   elevenlabs eleven_multilingual_v2 would READ tags aloud: same conversion
 *
 * Captions and every word count use `spokenText` — tags and *asterisks* never
 * reach the screen.
 */
import type { VoiceSpec } from "./voice.js";

/** Tags Soniox documents. Others "may be read aloud" — check-script warns. */
export const SONIOX_TAGS = new Set([
  // emotion
  "happy", "sad", "angry", "excited", "nervous", "fearful", "surprised", "annoyed", "relieved",
  "disappointed", "curious", "delighted", "calm",
  // tone & manner
  "warm", "stern", "serious", "playful", "sarcastic", "flirty", "deadpan", "sincerely", "reassuringly",
  "dramatically", "mockingly",
  // human sounds
  "laughs", "chuckles", "giggles", "sobs", "sniffles", "whimpers", "sighs", "exhales", "gasps", "grunts",
  "groans", "clears throat", "coughs", "yawns",
  // volume / pace / pitch / quality
  "whispering", "softly", "loudly", "shouting", "getting louder", "getting quieter", "trailing off",
  "muttering", "slowly", "quickly", "rushed", "drawn out", "hesitantly", "high-pitched", "low voice",
  "monotone", "breathy", "raspy", "trembling voice", "shaky",
  // pauses
  "pause", "long pause",
]);

const TAG_RE = /\[([^\]\n]{1,40})\]/g;

/** Every tag used in a line, lowercased, in order. */
export function tagsIn(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map((m) => m[1]!.trim().toLowerCase());
}

/** The words as heard/read: no tags, no *stress* asterisks, tidy spacing. */
export function spokenText(text: string): string {
  return text
    .replace(TAG_RE, " ")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/\s+([,.!?…;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Tags → punctuation for providers without tag support. Pauses become the
 * documented pause marks; sounds/emotions are dropped (better silent than read
 * aloud); *stress* loses its asterisks. Long ALL-CAPS words are softened to
 * Title case for Sarvam, which may spell them letter by letter; short ones
 * (AI, GPU, ETH) are left as acronyms.
 */
function toPunctuation(text: string, softenCaps: boolean): string {
  let out = text
    .replace(/\[\s*long pause\s*\]/gi, " … ")
    .replace(/\[\s*pause\s*\]/gi, ", ")
    .replace(TAG_RE, " ")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1");
  if (softenCaps) {
    out = out.replace(/\b([A-Z]{5,})\b/g, (w) => w[0] + w.slice(1).toLowerCase());
  }
  return out
    .replace(/\s+([,.!?…;:])/g, "$1")
    .replace(/([,…])\s*([,.!?…])/g, "$2")
    // a pause right after sentence punctuation is already a pause: "Rolex?," → "Rolex?"
    .replace(/([.!?])\s*,/g, "$1")
    .replace(/^[\s,…]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The exact text sent to a provider for this line. */
export function textForProvider(text: string, provider: VoiceSpec["provider"]): string {
  if (provider === "soniox") return text.replace(/\s{2,}/g, " ").trim();
  return toPunctuation(text, provider === "sarvam");
}

/** Problems with a line's delivery markup (for check-script). */
export function deliveryWarnings(text: string): string[] {
  const warnings: string[] = [];
  for (const t of tagsIn(text)) {
    if (!SONIOX_TAGS.has(t)) warnings.push(`unknown tag [${t}] — Soniox may read it aloud`);
  }
  const stacked = text.match(/(?:\[[^\]]+\]\s*){3,}/);
  if (stacked) warnings.push(`3+ stacked tags "${stacked[0].trim()}" — they pull in different directions`);
  if (/(.)\1{5,}/.test(spokenText(text))) warnings.push("a character repeated 6+ times degrades delivery");
  return warnings;
}
