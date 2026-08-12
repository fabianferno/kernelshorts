import { indexVault } from "./index-vault.js";
import { closeDb } from "../db/mongo.js";
import { config } from "../config.js";

const assets = await indexVault();

const byCategory = new Map<string, typeof assets>();
for (const a of assets) {
  byCategory.set(a.category, [...(byCategory.get(a.category) ?? []), a]);
}

console.log(`Indexed ${assets.length} assets from ${config.paths.vault}\n`);
for (const [category, list] of [...byCategory].sort()) {
  console.log(`${category}/  (${list.length})`);
  for (const a of list) {
    const bits = [
      a.durationS ? `${a.durationS.toFixed(1)}s` : undefined,
      a.width ? `${a.width}x${a.height}` : undefined,
      a.loudnessLufs !== undefined ? `${a.loudnessLufs} LUFS` : undefined,
      a.mood.length ? a.mood.join("/") : undefined,
    ].filter(Boolean);
    const flag = a.licenseStatus === "missing" ? "  ⚠️ NO LICENCE — excluded" : "";
    console.log(`  ${a.name}  ${bits.join("  ")}${flag}`);
  }
  console.log();
}

const unlicensed = assets.filter((a) => a.licenseStatus === "missing");
if (unlicensed.length) {
  console.log(
    `⚠️  ${unlicensed.length} asset(s) have no licence sidecar and will be ` +
      `excluded from selection. Add a sidecar .txt or a folder LICENSE.md.`,
  );
}

console.log(`Wrote ${config.paths.vaultIndex} and upserted to MongoDB.`);
await closeDb();
