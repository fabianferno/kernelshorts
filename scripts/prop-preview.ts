/**
 * Render one library prop on its own — the loop for building/fixing props.
 *
 *   pnpm exec tsx scripts/prop-preview.ts --list
 *   pnpm exec tsx scripts/prop-preview.ts <prop> [--theme dark|light] [--seconds 5]
 *        [--params '{"style":"gold"}'] [--counter '{"to":32768,"suffix":"/s"}'] [--tag "QUARTZ"]
 *        [--camera push|orbit|static]
 *
 * Writes ~/pipeline/props/<prop>-<theme>.mp4 plus a contact sheet .jpg.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { renderScene } from "../src/assets/generated/index.js";
import { GeneratedScene } from "../src/shared/schemas.js";
import { PROPS } from "../src/props/library.js";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--list") || !args[0]) {
  for (const p of PROPS) {
    console.log(`${p.id}\n  ${p.description}`);
    for (const [k, v] of Object.entries(p.params)) console.log(`    ${k}: ${v}`);
  }
  process.exit(0);
}

const prop = args[0]!;
const theme = (opt("--theme") ?? "dark") as "dark" | "light";
const seconds = Number(opt("--seconds") ?? 5);
const spec = GeneratedScene.parse({
  scene: "prop3d",
  prop,
  params: opt("--params") ? JSON.parse(opt("--params")!) : {},
  counter: opt("--counter") ? JSON.parse(opt("--counter")!) : undefined,
  tag: opt("--tag"),
  camera: opt("--camera") ?? "push",
});
const out = join(process.env.HOME ?? "~", "pipeline", "props", `${prop}-${theme}.mp4`);
const t0 = Date.now();
const r = await renderScene({ spec, durationS: seconds, outPath: out, theme, onProgress: (m) => console.log(`  ${m}`) });
const sheet = out.replace(/\.mp4$/, ".jpg");
await exec("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `fps=${6 / seconds},scale=270:-1,tile=6x1`, "-frames:v", "1", sheet]);
const { stdout } = await exec("ffmpeg", ["-i", out, "-vf", "mpdecimate", "-f", "null", "-"], {}).catch((e) => e);
const kept = String(stdout ?? "").match(/frame=\s*(\d+)/g)?.at(-1);
console.log(`${r.path}\n${r.durationS.toFixed(2)}s ${r.width}x${r.height} in ${((Date.now() - t0) / 1000).toFixed(1)}s\nsheet: ${sheet}${kept ? `\nunique frames: ${kept}` : ""}`);
