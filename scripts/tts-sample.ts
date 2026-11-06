/**
 * Hear a voice before committing a reel to it. Each sample costs its length in
 * ElevenLabs credits (cached afterwards, so re-running is free).
 *
 *   pnpm exec tsx scripts/tts-sample.ts [voiceId ...] [--text "..."]
 *
 * Writes ~/pipeline/samples/<voiceId>.wav (+ .words.json) and prints the
 * measured duration and word timings.
 */
import { join } from "node:path";
import { synthesizeEleven } from "../src/tts/elevenlabs.js";
import { config } from "../src/config.js";

const args = process.argv.slice(2);
const textIdx = args.indexOf("--text");
const text =
  textIdx >= 0
    ? args[textIdx + 1]!
    : "Did you know that Microsoft carved tiny rivers into an AI chip? So why would anyone run water through a computer?";
const voices = args.filter((a, i) => !a.startsWith("--") && i !== textIdx + 1);
const outDir = join(process.env.HOME ?? "~", "pipeline", "samples");

for (const voice of voices.length ? voices : [config.elevenlabs.voiceId]) {
  const clip = await synthesizeEleven({ text, voice, outPath: join(outDir, `${voice}.wav`) });
  console.log(
    `${voice}: ${clip.durationS.toFixed(2)}s ${clip.sampleRate}Hz model=${clip.model}` +
      `${clip.cached ? " (cached)" : ""}\n  ${clip.path}\n  ` +
      clip.words.map((w) => `${w.word}@${w.startS.toFixed(2)}`).join(" "),
  );
}
