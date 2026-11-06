import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeRun, findResumableRun } from "./run/execute.js";
import { ScriptJSON, RunState } from "./shared/schemas.js";
import { config } from "./config.js";
import { closeDb } from "./db/mongo.js";

/**
 * One-shot foreground run — the same executeRun() the server calls. This is
 * what the /reel skill drives, one approval point at a time.
 *
 *   tsx src/pipeline.ts <script.json> [--voice ID] [--self] [--stop-after-assets]
 *   tsx src/pipeline.ts --resume [<runDir-slug>] [--self]
 *
 *   --self               review mode "self": one build + deterministic checks,
 *                        no Bedrock. Claude Code reviews the frames.
 *   --stop-after-assets  voice + assets, then stop (no render).
 *   --resume [slug]      re-enter a run that has voice + assets (newest if no
 *                        slug given; slug = folder name under ~/pipeline/runs).
 *   --hook               with --resume: render only the first 10 s (Gate 2).
 *   --character ID       host character (vault/characters/ID); picks the voice too.
 *   --refresh-scenes     with --resume: re-render generated/3D scenes with current code.
 *
 * Prints a final machine-readable line: `RESULT {json}`.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = new Set(["--voice", "--character"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));

const reviewer = flag("--self") ? ("self" as const) : undefined;
const voice = value("--voice");
const character = value("--character");
const onProgress = (m: string) => console.log(m);

async function resumeTarget(slug?: string): Promise<RunState | undefined> {
  if (!slug) return findResumableRun();
  const statePath = join(config.paths.runsRoot, slug, "state.json");
  return RunState.parse(JSON.parse(await readFile(statePath, "utf8")));
}

try {
  let result;
  if (flag("--resume")) {
    const state = await resumeTarget(positional[0]);
    if (!state) {
      console.error("nothing to resume.");
      process.exit(1);
    }
    console.log(`resuming ${state.run_id} (phase "${state.phase}")\n`);
    result = await executeRun({
      resume: true,
      runId: state.run_id,
      dateSlug: state.date_slug,
      voice,
      reviewer,
      hookOnly: flag("--hook"),
      refreshScenes: flag("--refresh-scenes"),
      character,
      onProgress,
    });
  } else if (!positional[0]) {
    console.error(
      "usage: tsx src/pipeline.ts <script.json> [--voice ID] [--self] [--stop-after-assets]\n" +
        "       tsx src/pipeline.ts --resume [slug] [--self]",
    );
    process.exit(2);
  } else {
    const raw = JSON.parse(await readFile(positional[0], "utf8"));
    const script = ScriptJSON.parse({ run_id: "pending", ...raw });
    result = await executeRun({
      script,
      voice,
      reviewer,
      stopAfterAssets: flag("--stop-after-assets"),
      character,
      onProgress,
    });
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  if (result.status === "failed") process.exitCode = 1;
} finally {
  await closeDb();
}
