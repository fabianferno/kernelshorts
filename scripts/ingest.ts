/**
 * Asset intake: hand me files, I put them where the pipeline can use them.
 *
 *   pnpm assets:add <file-or-folder> [...]   # anything, anywhere on disk (copied, never moved)
 *   pnpm assets:add                          # whatever is in vault/inbox/ (moved out when done)
 *     --pack <name>        group name (default: the source folder's name)
 *     --license "<text>"   licence statement to record when the source has none
 *     --dry                show the plan, change nothing
 *
 * Routing (by content, not just extension):
 *   fonts  .ttf/.otf            → vault/fonts/<Family-Style>/      (+ licence files)
 *   video  green-screen         → vault/overlays/<pack>/<name>.webm  keyed to VP9+alpha
 *   video  everything else      → vault/stock/<pack>/
 *   image                       → vault/images/<pack>/
 *   audio  < 20 s               → vault/sfx/<pack>/
 *   audio  ≥ 20 s               → vault/music/<pack>/
 * Licence files found in the source folder (LICENSE*, *licen*.pdf/txt, README*)
 * are copied alongside; with none and no --license, the indexer marks the pack
 * `licenseStatus: missing` and the pipeline won't pick from it.
 * Finishes by re-indexing the vault (vault.index.json).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { slugify } from "../src/run/execute.js";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const VAULT = join(ROOT, "vault");
const INBOX = join(VAULT, "inbox");

const FONT = new Set([".ttf", ".otf"]);
const VIDEO = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".aiff"]);
const LICENSE_RE = /^(licen[cs]e|readme|ofl|copying)|licen[cs]e/i;

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes("--dry");
const packOverride = opt("--pack");
const licenseText = opt("--license");
const valueFlags = new Set(["--pack", "--license"]);
const sources = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
const fromInbox = sources.length === 0;

async function walk(p: string): Promise<string[]> {
  const st = await stat(p);
  if (!st.isDirectory()) return [p];
  const out: string[] = [];
  for (const e of await readdir(p, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    out.push(...(await walk(join(p, e.name))));
  }
  return out;
}

async function durationS(p: string): Promise<number> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]);
  return Number(stdout.trim()) || 0;
}

/**
 * Green-screen detection: average colour of the four corners of a frame ~30%
 * in. Returns the key colour (hex) when the corners are strongly green.
 */
async function greenKey(p: string): Promise<string | undefined> {
  const at = Math.max(0, (await durationS(p)) * 0.3);
  const { stdout } = await exec(
    "ffmpeg",
    ["-v", "error", "-ss", String(at), "-i", p, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 20 },
  );
  const px = (x: number, y: number) => {
    const o = (y * 64 + x) * 3;
    return [stdout[o]!, stdout[o + 1]!, stdout[o + 2]!];
  };
  const corners = [px(1, 1), px(62, 1), px(1, 34), px(62, 34)];
  const [r, g, b] = [0, 1, 2].map((c) => corners.reduce((s, k) => s + k[c]!, 0) / 4) as [number, number, number];
  if (g > 100 && g > r * 1.4 && g > b * 1.4) {
    return "0x" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  }
  return undefined;
}

interface Planned {
  src: string;
  dest: string;
  action: "copy" | "key";
  key?: string;
  category: string;
}

async function plan(src: string, root: string): Promise<Planned | undefined> {
  const ext = extname(src).toLowerCase();
  const pack = slugify(packOverride ?? (src === root ? "misc" : basename(root)), 40);
  const name = basename(src, extname(src));
  if (FONT.has(ext)) {
    return { src, dest: join(VAULT, "fonts", name, basename(src)), action: "copy", category: "fonts" };
  }
  if (VIDEO.has(ext)) {
    const key = await greenKey(src);
    if (key) {
      return { src, dest: join(VAULT, "overlays", pack, `${name}.webm`), action: "key", key, category: "overlays" };
    }
    return { src, dest: join(VAULT, "stock", pack, basename(src)), action: "copy", category: "stock" };
  }
  if (IMAGE.has(ext)) return { src, dest: join(VAULT, "images", pack, basename(src)), action: "copy", category: "images" };
  if (AUDIO.has(ext)) {
    const cat = (await durationS(src)) < 20 ? "sfx" : "music";
    return { src, dest: join(VAULT, cat, pack, basename(src)), action: "copy", category: cat };
  }
  return undefined;
}

/** Green → alpha, then VP9 with alpha in WebM (Chromium plays it with transparency). */
async function keyToWebm(src: string, dest: string, key: string): Promise<void> {
  await exec("ffmpeg", [
    "-v", "error", "-y", "-i", src,
    // chromakey (YUV distance) at a TIGHT similarity: the first cut used
    // colorkey at 0.28 and punched holes through shadowed skin, which carries
    // green spill. 0.12/0.05 keeps the hand solid on the Bare Hand pack.
    "-vf", `chromakey=${key}:0.12:0.05,despill=type=green:mix=0.5:expand=0.1,format=yuva420p`,
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30",
    "-auto-alt-ref", "0", "-an", dest,
  ]);
}

const roots = fromInbox ? (existsSync(INBOX) ? (await readdir(INBOX)).filter((n) => !n.startsWith(".")).map((n) => join(INBOX, n)) : []) : sources.map((s) => resolve(s));
if (roots.length === 0) {
  console.log(`nothing to ingest — pass a path, or drop files into ${INBOX}`);
  process.exit(0);
}

const plans: Planned[] = [];
const licenseFiles = new Map<string, string[]>(); // dest dir → licence sources
for (const root of roots) {
  const files = await walk(root);
  const licences = files.filter((f) => LICENSE_RE.test(basename(f)) && /\.(md|txt|pdf)$/i.test(f));
  for (const f of files) {
    if (licences.includes(f)) continue;
    const p = await plan(f, root);
    if (!p) continue;
    plans.push(p);
    const d = dirname(p.dest);
    if (!licenseFiles.has(d)) licenseFiles.set(d, licences);
  }
}

const byDir = new Map<string, Planned[]>();
for (const p of plans) byDir.set(dirname(p.dest), [...(byDir.get(dirname(p.dest)) ?? []), p]);
for (const [dir, ps] of byDir) {
  const lic = licenseFiles.get(dir) ?? [];
  console.log(
    `${dir.replace(VAULT + "/", "vault/")}  ← ${ps.length} file(s)` +
      (ps.some((p) => p.action === "key") ? ` (green screen → alpha webm)` : "") +
      (lic.length ? `  licence: ${lic.map((l) => basename(l)).join(", ")}` : licenseText ? `  licence: --license` : `  licence: NONE`),
  );
}
if (dry) process.exit(0);

let done = 0;
for (const p of plans) {
  await mkdir(dirname(p.dest), { recursive: true });
  if (p.action === "key") await keyToWebm(p.src, p.dest, p.key!);
  else await copyFile(p.src, p.dest);
  done++;
  if (done % 10 === 0) console.log(`  ${done}/${plans.length}`);
}
for (const [dir] of byDir) {
  const lic = licenseFiles.get(dir) ?? [];
  for (const l of lic) await copyFile(l, join(dir, basename(l)));
  if (lic.length && !lic.some((l) => /^license\.md$/i.test(basename(l)))) {
    await writeFile(join(dir, "LICENSE.md"), `See ${lic.map((l) => basename(l)).join(", ")} (copied from ${dirname(lic[0]!)}).\n`);
  } else if (!lic.length && licenseText) {
    await writeFile(join(dir, "LICENSE.md"), `${licenseText}\n\n(recorded by scripts/ingest.ts on ${new Date().toISOString().slice(0, 10)})\n`);
  }
}
if (fromInbox) {
  const doneDir = join(INBOX, ".done", new Date().toISOString().slice(0, 10));
  await mkdir(doneDir, { recursive: true });
  for (const r of roots) await rename(r, join(doneDir, basename(r)));
}
console.log(`ingested ${plans.length} file(s). Re-indexing…`);
await exec("pnpm", ["vault:index"], { cwd: ROOT });
console.log("vault.index.json updated.");
