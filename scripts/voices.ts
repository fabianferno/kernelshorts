/**
 * Every voice you can give a character, per provider.
 *
 *   pnpm voices                 # all providers
 *   pnpm voices elevenlabs      # one provider
 *   pnpm voices --sample sarvam:priya ["text"]   # hear one (costs that provider's credits; cached after)
 *
 * To use a voice, set it in vault/characters/<id>/character.json:
 *   "voice": { "provider": "sarvam", "voiceId": "priya", "model": "bulbul:v3", "language": "en-IN" }
 */
import { join } from "node:path";
import { config } from "../src/config.js";
import { listVoices as listSoniox } from "../src/tts/soniox.js";
import { SARVAM_SPEAKERS } from "../src/tts/sarvam.js";
import { synthesizeVoice, parseVoiceOverride } from "../src/tts/voice.js";
import { listCharacters, loadCharacter } from "../src/host/characters.js";

const args = process.argv.slice(2);

if (args[0] === "--sample") {
  const spec = parseVoiceOverride(args[1], { provider: "elevenlabs", voiceId: config.elevenlabs.voiceId });
  const text = args[2] ?? "Did you know that one tiny crystal keeps better time than a Rolex?";
  const out = join(process.env.HOME ?? "~", "pipeline", "samples", `${spec.provider}-${spec.voiceId}.wav`);
  const clip = await synthesizeVoice(spec, { text, outPath: out });
  console.log(`${clip.path}\n${clip.durationS.toFixed(2)}s · ${clip.words.length} timed words${clip.cached ? " (cached)" : ""}`);
  process.exit(0);
}

const only = args[0];
const show = (p: string) => !only || only === p;

console.log("Characters now:");
for (const id of listCharacters()) {
  const c = loadCharacter(id);
  console.log(`  ${id.padEnd(10)} ${c.gender.padEnd(7)} ${c.voice.provider}:${c.voice.voiceId}  ${c.voice.label ?? ""}`);
}

if (show("elevenlabs")) {
  console.log("\nELEVENLABS  (free plan: premade voices only; library voices need a paid plan)");
  const sub = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": config.elevenlabs.apiKey } })
    .then((r) => r.json() as Promise<{ tier?: string; character_count?: number; character_limit?: number }>)
    .catch(() => ({}) as { tier?: string; character_count?: number; character_limit?: number });
  console.log(`  plan: ${sub.tier ?? "?"} · ${sub.character_count ?? "?"} / ${sub.character_limit ?? "?"} characters used`);
  const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": config.elevenlabs.apiKey } });
  const { voices = [] } = (await res.json()) as {
    voices?: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }>;
  };
  const free = sub.tier === "free";
  for (const v of voices.sort((a, b) => (a.category === "premade" ? 0 : 1) - (b.category === "premade" ? 0 : 1))) {
    const usable = !free || v.category === "premade" || v.category === "generated" || v.category === "cloned";
    console.log(
      `  ${usable ? "✓" : "✗ paid"} ${(v.labels?.gender ?? "").padEnd(7)} ${(v.labels?.accent ?? "").padEnd(11)} ` +
        `elevenlabs:${v.voice_id}  ${v.name}`,
    );
  }
}

if (show("soniox")) {
  console.log("\nSONIOX  (your clones; built-in names like \"Adrian\" also work)");
  try {
    for (const v of await listSoniox()) {
      const ready = v.models.filter((m) => m.status === "ready").map((m) => m.model);
      console.log(`  ${ready.length ? "✓" : "✗ not ready"} soniox:${v.name.padEnd(12)} ${v.id}  ${ready.join(", ")}`);
    }
  } catch (e) {
    console.log(`  (could not list: ${(e as Error).message.slice(0, 120)})`);
  }
}

if (show("sarvam")) {
  console.log(`\nSARVAM  (Indian English + Indic; ${config.sarvam.apiKey ? "key set" : "NO KEY — add SARVAM_API_KEY to .env"})`);
  for (const model of ["bulbul:v3", "bulbul:v2"]) {
    const sp = SARVAM_SPEAKERS.filter((s) => s.model === model);
    console.log(`  ${model}: ${sp.map((s) => `sarvam:${s.id}${s.gender ? ` (${s.gender[0]})` : ""}`).join("  ")}`);
  }
  console.log("  bulbul:v4-flash: 200+ personas (e.g. simran_en_customer) — see docs.sarvam.ai voices guide");
}
