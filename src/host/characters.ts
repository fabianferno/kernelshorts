import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";

/**
 * Characters (on-screen hosts) and brand — both are DATA in the vault, not code,
 * so adding a host or rebranding never needs a code change.
 *
 *   vault/characters/<id>/
 *     character.json   { name, gender, voice: { provider, voiceId, label } }
 *     reference.png    the drawing every pose is generated from
 *     character.txt    one-line description for the image model
 *     poses/           <pose>.png + <pose>-open.png (scripts/gen-host.ts)
 *   vault/brand/brand.json  { name, accent, defaultCharacter }
 *
 * Which character a reel uses: script.character → --character → brand.defaultCharacter.
 * Its voice is the character's unless --voice overrides.
 */

const CHARACTERS_DIR = join(config.paths.vault, "characters");
const BRAND_FILE = join(config.paths.vault, "brand", "brand.json");

export const CharacterFile = z.object({
  name: z.string().min(1),
  gender: z.enum(["female", "male", "other"]),
  voice: z.object({
    provider: z.literal("elevenlabs"),
    voiceId: z.string().min(1),
    label: z.string().optional(),
  }),
});

export interface Character extends z.infer<typeof CharacterFile> {
  id: string;
  dir: string;
  posesDir: string;
  referencePath: string;
  descriptionPath: string;
}

export const Brand = z.object({
  name: z.string().min(1),
  /** Accent colour for the chrome dot/dashes/badge and the emphasis box. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3B82F6"),
  defaultCharacter: z.string().optional(),
});
export type Brand = z.infer<typeof Brand>;

export function loadBrand(): Brand {
  if (!existsSync(BRAND_FILE)) return Brand.parse({ name: config.brand });
  return Brand.parse(JSON.parse(readFileSync(BRAND_FILE, "utf8")));
}

export function listCharacters(): string[] {
  if (!existsSync(CHARACTERS_DIR)) return [];
  return readdirSync(CHARACTERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(CHARACTERS_DIR, d.name, "character.json")))
    .map((d) => d.name);
}

export function loadCharacter(id?: string): Character {
  const chosen = id ?? loadBrand().defaultCharacter ?? listCharacters()[0];
  if (!chosen) throw new Error(`no characters in ${CHARACTERS_DIR}`);
  const dir = join(CHARACTERS_DIR, chosen);
  const file = join(dir, "character.json");
  if (!existsSync(file)) {
    throw new Error(`unknown character "${chosen}" — have: ${listCharacters().join(", ") || "none"}`);
  }
  return {
    ...CharacterFile.parse(JSON.parse(readFileSync(file, "utf8"))),
    id: chosen,
    dir,
    posesDir: join(dir, "poses"),
    referencePath: join(dir, "reference.png"),
    descriptionPath: join(dir, "character.txt"),
  };
}
