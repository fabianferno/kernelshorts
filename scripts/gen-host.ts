/**
 * Generates the host pose library (src/host/poses.ts) with the Antigravity CLI's
 * `image-generator` sub-agent (Gemini — free image generation).
 *
 *   pnpm exec tsx scripts/gen-host.ts                # every missing pose
 *   pnpm exec tsx scripts/gen-host.ts shrug wave     # just these
 *   pnpm exec tsx scripts/gen-host.ts --rekey        # only re-run the chroma key
 *   pnpm exec tsx scripts/gen-host.ts --force shrug  # regenerate even if present
 *
 * Input:  vault/host/reference.png — the character, in any pose.
 * Output: vault/host/poses/<id>.green.jpg / <id>-open.green.jpg (raw) and
 *         <id>.png / <id>-open.png (keyed, transparent).
 *
 * Two agy behaviours this works around, both observed on 2026-11-06:
 *  - `agy -p` returns as soon as the sub-agent is LAUNCHED, not when it
 *    finishes. The sub-agent keeps running and finishes on its own.
 *  - The sub-agent ignores the requested output path and writes into
 *    ~/.gemini/antigravity-cli/brain/<conversation>/<stem>_<timestamp>.jpg.
 * So each job asks for a unique stem, then polls the brain directory for it.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { POSES, type PoseSpec } from "../src/host/poses.js";

const exec = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "..");
const HOST_DIR = join(ROOT, "vault", "host");
const POSE_DIR = join(HOST_DIR, "poses");
const REFERENCE = join(HOST_DIR, "reference.png");
const BRAIN = join(homedir(), ".gemini", "antigravity-cli", "brain");
const CONCURRENCY = 3;
const POLL_TIMEOUT_MS = 8 * 60_000;

/**
 * How to describe the character to the image model. Lives next to the
 * reference image (vault/host/character.txt) so swapping characters is a data
 * change, not a code change.
 */
const CHARACTER_FILE = join(HOST_DIR, "character.txt");
let CHARACTER = "";
const FRAMING =
  "Framing: waist-up, character horizontally centered, top of the hair at about 10% from " +
  "the top edge, waist cut off at the bottom edge, same scale as the reference. Background: " +
  "perfectly flat solid pure green #00FF00 — no grid, no shadow, no gradient, no floor, " +
  "nothing else in the frame. Portrait aspect ratio about 3:4.";

/** Gemini's free image quota is per rolling window; once hit, every further call fails. */
class QuotaExhausted extends Error {}
const QUOTA_RE = /RESOURCE_EXHAUSTED|exhausted your capacity|quota|429 Too Many Requests/i;

function runAgy(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "agy",
      ["-p", prompt, "--mode", "accept-edits", "--print-timeout", "300s"],
      { cwd: HOST_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (QUOTA_RE.test(out)) return reject(new QuotaExhausted(quotaMessage(out)));
      return code === 0 ? resolvePromise(out) : reject(new Error(`agy exited ${code}: ${out.slice(-500)}`));
    });
  });
}

function quotaMessage(text: string): string {
  const reset = text.match(/reset after ([0-9hms.]+)/i)?.[1];
  return `Gemini image quota exhausted${reset ? ` — resets in ${reset}` : ""}. Re-run later; finished poses are kept.`;
}

/** agy's own log is where the sub-agent's 429 actually lands (print mode exits before it). */
async function quotaHitSince(since: number): Promise<string | undefined> {
  const log = join(homedir(), ".gemini", "antigravity-cli", "cli.log");
  if (!existsSync(log) || (await stat(log)).mtimeMs < since) return undefined;
  const { stdout } = await exec("tail", ["-c", "200000", log]);
  const lines = stdout.split("\n").filter((l) => /generate_image.*(429|RESOURCE_EXHAUSTED|exhausted)/i.test(l));
  if (lines.length === 0) return undefined;
  // glog lines start "E1106 05:09:04.87…" — compare against `since` using today's date.
  const m = lines.at(-1)!.match(/^[EWI](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const now = new Date();
  const at = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (at < since) return undefined;
  const tailText = stdout.slice(stdout.lastIndexOf(lines.at(-1)!));
  return quotaMessage(tailText);
}

/** Newest image in the brain dir whose name starts with `stem`, written after `since`. */
async function findOutput(stem: string, since: number): Promise<string | undefined> {
  if (!existsSync(BRAIN)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const conv of await readdir(BRAIN)) {
    const dir = join(BRAIN, conv);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(`${stem}_`) || !/\.(jpe?g|png|webp)$/i.test(name)) continue;
      const path = join(dir, name);
      const { mtimeMs } = await stat(path);
      if (mtimeMs >= since && (!best || mtimeMs > best.mtime)) best = { path, mtime: mtimeMs };
    }
  }
  return best?.path;
}

async function generate(stem: string, prompt: string, dest: string): Promise<void> {
  const since = Date.now() - 1000;
  await runAgy(prompt);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const quota = await quotaHitSince(since);
    if (quota) throw new QuotaExhausted(quota);
    const found = await findOutput(stem, since);
    if (found) {
      // The sub-agent may still be flushing the file; wait for its size to settle.
      let size = -1;
      for (;;) {
        const s = (await stat(found)).size;
        if (s === size && s > 0) break;
        size = s;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await copyFile(found, dest);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`no output named ${stem}_* appeared in ${BRAIN} within ${POLL_TIMEOUT_MS / 60000} min`);
}

/** Green → transparent. JPEG edges are soft, so similarity is generous and spill is removed. */
async function key(src: string, dest: string): Promise<void> {
  await exec("ffmpeg", [
    "-v", "error", "-y", "-i", src,
    "-vf", "colorkey=0x00FF00:0.32:0.06,despill=type=green:mix=0.6:expand=0.1,format=rgba",
    "-frames:v", "1", dest,
  ]);
}

async function makePose(pose: PoseSpec, force: boolean): Promise<void> {
  const closedRaw = join(POSE_DIR, `${pose.id}.green.jpg`);
  const openRaw = join(POSE_DIR, `${pose.id}-open.green.jpg`);
  const tag = Date.now().toString(36);

  if (force || !existsSync(closedRaw)) {
    const stem = `ks_${pose.id.replace(/-/g, "_")}_closed_${tag}`;
    console.log(`[${pose.id}] generating (mouth closed)…`);
    await generate(
      stem,
      `Use the image-generator sub-agent. Reference image: ./reference.png. Generate a NEW ` +
        `image of ${CHARACTER}, in this pose: ${pose.prompt}. Mouth closed with a slight ` +
        `smile. ${FRAMING} Name the output file ${stem}. Wait for the sub-agent to finish.`,
      closedRaw,
    );
  }

  if (force || !existsSync(openRaw)) {
    const stem = `ks_${pose.id.replace(/-/g, "_")}_open_${tag}`;
    console.log(`[${pose.id}] generating (mouth open)…`);
    await generate(
      stem,
      `Use the image-generator sub-agent to EDIT the image ./poses/${pose.id}.green.jpg. ` +
        `Change ONLY the mouth: open it naturally as if in the middle of saying a word ` +
        `(teeth slightly visible). Keep EVERYTHING else identical — same pose, same hands, ` +
        `same position and scale, same flat pure green #00FF00 background. ` +
        `Name the output file ${stem}. Wait for the sub-agent to finish.`,
      openRaw,
    );
  }

  await key(closedRaw, join(POSE_DIR, `${pose.id}.png`));
  await key(openRaw, join(POSE_DIR, `${pose.id}-open.png`));
  console.log(`[${pose.id}] done`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const rekeyOnly = args.includes("--rekey");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const poses = wanted.length ? POSES.filter((p) => wanted.includes(p.id)).sort((a, b) => wanted.indexOf(a.id) - wanted.indexOf(b.id)) : POSES;
  const unknown = wanted.filter((w) => !POSES.some((p) => p.id === w));
  if (unknown.length) throw new Error(`unknown pose id(s): ${unknown.join(", ")}`);
  if (!existsSync(REFERENCE)) throw new Error(`missing ${REFERENCE} — put the character image there`);
  if (!existsSync(CHARACTER_FILE)) {
    throw new Error(`missing ${CHARACTER_FILE} — one line describing the character (hair, glasses, clothes, style)`);
  }
  CHARACTER = (await readFile(CHARACTER_FILE, "utf8")).trim();
  await mkdir(POSE_DIR, { recursive: true });

  if (rekeyOnly) {
    for (const p of poses) {
      for (const suffix of ["", "-open"]) {
        const raw = join(POSE_DIR, `${p.id}${suffix}.green.jpg`);
        if (existsSync(raw)) await key(raw, join(POSE_DIR, `${p.id}${suffix}.png`));
      }
    }
    console.log(`re-keyed ${poses.length} pose(s)`);
    return;
  }

  const queue = [...poses];
  const failures: string[] = [];
  let quotaHit: string | undefined;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let p = queue.shift(); p && !quotaHit; p = queue.shift()) {
        try {
          await makePose(p, force);
        } catch (err) {
          if (err instanceof QuotaExhausted) {
            quotaHit = err.message;
            queue.length = 0;
            break;
          }
          failures.push(`${p.id}: ${(err as Error).message}`);
          console.error(`[${p.id}] FAILED: ${(err as Error).message}`);
        }
      }
    }),
  );
  if (quotaHit) {
    console.error(`\n${quotaHit}`);
    process.exitCode = 2;
  }
  if (failures.length) {
    console.error(`\n${failures.length} pose(s) failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
}

await main();
