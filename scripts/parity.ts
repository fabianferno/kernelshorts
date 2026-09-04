/**
 * Parity harness — drives the HyperFrames edit backend over a REAL, already
 * completed run and times it, so its output can be compared against the
 * Palmier master that run archived.
 *
 *   pnpm exec tsx scripts/parity.ts <run-id> [--runs-root <dir>] [--out <dir>]
 *                                            [--skip-high]
 *
 * e.g. pnpm exec tsx scripts/parity.ts 2026-08-18
 *
 * The Palmier side is NOT re-rendered: it needs the desktop app running, and
 * every completed run already archives its real exports under `exports/`.
 * Those files ARE the baseline; this script produces the other half.
 *
 * The run directory is READ-ONLY here. `~/pipeline/runs/<id>` holds the user's
 * real artifacts, so the harness copies nothing into it and points the build's
 * workspace at a scratch tree under `.parity/` in the repo instead.
 *
 * Timing is the point of this script, not a side effect. `build()` renders
 * DRAFT (the quality every review-loop iteration pays for) and
 * `renderFinalMaster()` re-renders the same checkpointed composition at HIGH
 * (the quality the master pays for, once). Both are wall-clocked separately
 * and written to `parity.json` next to the outputs.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { build, renderFinalMaster } from "../src/edit/build.js";
import { ScriptJSON, AssetManifest } from "../src/shared/schemas.js";

interface Args {
  runId: string;
  runsRoot: string;
  outRoot: string;
  skipHigh: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else flags.set(key, true);
  }
  const runId = positional[0];
  if (!runId) {
    throw new Error(
      "usage: pnpm exec tsx scripts/parity.ts <run-id> [--runs-root <dir>] [--out <dir>] [--skip-high]",
    );
  }
  const asPath = (v: string | true | undefined, fallback: string): string =>
    typeof v === "string" ? (isAbsolute(v) ? v : resolve(process.cwd(), v)) : fallback;
  return {
    runId,
    runsRoot: asPath(flags.get("runs-root"), join(homedir(), "pipeline", "runs")),
    outRoot: asPath(flags.get("out"), join(process.cwd(), ".parity")),
    skipHigh: flags.get("skip-high") === true,
  };
}

/**
 * A completed run keeps BOTH the script and the asset manifest as top-level
 * keys of `state.json` — the finished, measured versions, with real VO
 * durations and real asset paths. Reconstructing them from `script.json` plus
 * the assets directory would re-derive numbers that the run already settled,
 * so read them from state and validate through the same schemas the pipeline
 * validates with.
 */
async function loadRun(runDir: string): Promise<{ script: ScriptJSON; manifest: AssetManifest }> {
  const raw = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;
  if (!raw.script || !raw.manifest) {
    throw new Error(`${runDir}/state.json has no "script"/"manifest" — is this a completed run?`);
  }
  return {
    script: ScriptJSON.parse(raw.script),
    manifest: AssetManifest.parse(raw.manifest),
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runDir = join(args.runsRoot, args.runId);
  const { script, manifest } = await loadRun(runDir);

  // Scratch workspace — the run directory itself is never written to.
  const workRoot = join(args.outRoot, args.runId);
  const workspace = {
    root: workRoot,
    exports: join(workRoot, "exports"),
    checkpoints: join(workRoot, "checkpoints"),
  };
  for (const dir of [workspace.root, workspace.exports, workspace.checkpoints]) {
    await mkdir(dir, { recursive: true });
  }

  console.log(`parity: run ${args.runId} (${script.run_id}), ${script.beats.length} beats`);
  console.log(`parity: reading  ${runDir} (read-only)`);
  console.log(`parity: writing  ${workRoot}`);
  console.log(`parity: baseline ${join(runDir, "exports")}\n`);

  const timings: Record<string, number> = {};
  const log = (m: string) => console.log(`  ${m}`);

  // DRAFT — what every review-loop iteration costs.
  const draftStart = Date.now();
  const result = await build({
    script,
    manifest,
    workspace,
    iteration: 1,
    final: false,
    onProgress: log,
  });
  timings.buildAndDraftRenderMs = Date.now() - draftStart;
  console.log(`\nparity: draft build+render ${secs(timings.buildAndDraftRenderMs)} -> ${result.exportPath}`);

  // HIGH — what the single final master costs, from the same checkpoint, so
  // the only difference between the two numbers is the encode.
  let highPath: string | undefined;
  if (!args.skipHigh) {
    const highStart = Date.now();
    highPath = await renderFinalMaster(
      {
        checkpointPath: result.checkpointPath,
        exportPath: join(workspace.exports, `${script.run_id}-high.mp4`),
        onProgress: log,
      },
    );
    timings.highRenderMs = Date.now() - highStart;
    console.log(`parity: high render ${secs(timings.highRenderMs)} -> ${highPath}`);
  }

  const summary = {
    runId: args.runId,
    scriptRunId: script.run_id,
    beats: result.plan.map((p) => ({
      beatId: p.beatId,
      startFrame: p.startFrame,
      endFrame: p.endFrame,
      midpointS: (p.startFrame + p.endFrame) / 2 / 30,
      voDurationS: p.voDurationS,
      assetKind: p.asset.kind,
      assetDurationS: p.asset.durationS,
      /** True where Palmier stretched with `speed` and HyperFrames clamps. */
      assetShorterThanBeat: (p.asset.durationS ?? 0) < (p.endFrame - p.startFrame) / 30,
      onScreenText: p.onScreenText,
    })),
    totalFrames: result.totalFrames,
    projectDir: result.projectDir,
    checkpointPath: result.checkpointPath,
    draftExport: result.exportPath,
    highExport: highPath,
    palmierBaselineDir: join(runDir, "exports"),
    timings,
    generatedAt: new Date().toISOString(),
  };
  const summaryPath = join(workRoot, "parity.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nparity: summary -> ${summaryPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
