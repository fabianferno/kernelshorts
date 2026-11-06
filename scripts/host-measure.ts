/**
 * (Re)measure head + mouth geometry for every drawn pose of every character
 * (src/host/measure.ts). Run after generating poses; compose also measures
 * lazily, so this is mainly for inspection.
 *
 *   pnpm exec tsx scripts/host-measure.ts [--force]
 */
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { listCharacters, loadCharacter } from "../src/host/characters.js";
import { availableHostPoses } from "../src/edit/compose.js";
import { metaPath, poseMeta } from "../src/host/measure.js";

const force = process.argv.includes("--force");
for (const id of listCharacters()) {
  const c = loadCharacter(id);
  for (const pose of availableHostPoses(c.posesDir)) {
    if (force && existsSync(metaPath(c.posesDir, pose))) await rm(metaPath(c.posesDir, pose));
    const m = await poseMeta(c.posesDir, pose);
    const head = m.mouth.y - m.headTop;
    console.log(
      `${id.padEnd(8)} ${pose.padEnd(12)} ${m.width}x${m.height}  headTop ${m.headTop}  ` +
        `mouth (${m.mouth.x},${m.mouth.y}) ${m.mouth.w}x${m.mouth.h}  head→mouth ${head}px`,
    );
  }
}
