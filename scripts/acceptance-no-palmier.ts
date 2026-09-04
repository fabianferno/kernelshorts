/**
 * ACCEPTANCE — the whole edit → review → deliver path with the Palmier
 * desktop app ABSENT and `EDIT_BACKEND` left at its (now hyperframes)
 * default.
 *
 *   pnpm exec tsx scripts/acceptance-no-palmier.ts <run-id>
 *                 [--runs-root <dir>] [--out <dir>]
 *
 * e.g. pnpm exec tsx scripts/acceptance-no-palmier.ts 2026-08-18
 *
 * WHY THIS AND NOT `executeRun`. The migration plan asks for "a full pipeline
 * end to end with Palmier not running". `executeRun` cannot run unattended:
 * it blocks on `waitForGate` for Gate A, which needs a human approval. So this
 * drives the phases AFTER that gate — the only phases the migration touched —
 * from a real completed run's artifacts, in the same order and through the
 * same functions the review loop calls:
 *
 *   1. Palmier is proven UNREACHABLE first, so nothing below can be quietly
 *      leaning on the desktop app.
 *   2. `build()`     — compose the project and render DRAFT, exactly as every
 *                      review-loop iteration does.
 *   3. `renderFinalMaster()` + `normalizeLoudness()` — exactly what the loop's
 *      `finalizeMaster` does to the winning iteration.
 *   4. `runLayer1()` — the REAL Layer-1 function the loop calls (imported, not
 *      reimplemented): container, loudness, black frames, frozen frames,
 *      timeline_gaps (beat plan) and caption_safe_area (MEASURED in a browser
 *      against the composed index.html), plus script_fidelity.
 *   5. The deliverable checks `deliver()` performs on the master: canvas size
 *      and the format duration window.
 *
 * DELIBERATELY NOT RUN:
 *   - Layer 2 (the vision reviewer). It is 3 Bedrock vision calls per
 *     iteration on the user's credits, it is unchanged by this migration, and
 *     it never touched Palmier. Layer 1 is what this acceptance needs to prove.
 *   - `deliver()` itself. Its remaining work is a Mongo/GridFS write, a
 *     Bedrock metadata call, a push notification and opening Gate C — none of
 *     which the migration touched, and all of which would write real run
 *     records and drop a file into the user's real `~/pipeline/out`. Its
 *     deterministic gate on the master (canvas + duration) IS checked here.
 *
 * The run directory is READ-ONLY: everything is written to a scratch tree.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { config } from "../src/config.js";
import { build, renderFinalMaster } from "../src/edit/build.js";
import { normalizeLoudness } from "../src/verify/media.js";
import { runLayer1 } from "../src/review/loop.js";
import { ScriptJSON, AssetManifest } from "../src/shared/schemas.js";

interface Args {
  runId: string;
  runsRoot: string;
  outRoot: string;
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
      "usage: pnpm exec tsx scripts/acceptance-no-palmier.ts <run-id> " +
        "[--runs-root <dir>] [--out <dir>]",
    );
  }
  const asPath = (v: string | true | undefined, fallback: string): string =>
    typeof v === "string" ? (isAbsolute(v) ? v : resolve(process.cwd(), v)) : fallback;
  return {
    runId,
    runsRoot: asPath(flags.get("runs-root"), join(homedir(), "pipeline", "runs")),
    outRoot: asPath(flags.get("out"), join(process.cwd(), ".acceptance")),
  };
}

/**
 * Proves the desktop app is not running before anything else happens. A green
 * acceptance run means nothing if Palmier happened to be up.
 */
async function assertPalmierAbsent(): Promise<string> {
  const url = config.palmierMcpUrl;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
  } catch (err) {
    return `${url} unreachable (${(err as Error).message})`;
  }
  throw new Error(
    `${url} ANSWERED — the Palmier desktop app is running, so this run would not ` +
      `prove anything. Quit Palmier and re-run.`,
  );
}

async function loadRun(runDir: string): Promise<{ script: ScriptJSON; manifest: AssetManifest }> {
  const raw = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;
  if (!raw.script || !raw.manifest) {
    throw new Error(`${runDir}/state.json has no "script"/"manifest" — is this a completed run?`);
  }
  return { script: ScriptJSON.parse(raw.script), manifest: AssetManifest.parse(raw.manifest) };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`acceptance: palmier — ${await assertPalmierAbsent()}`);
  if (process.env.EDIT_BACKEND) {
    throw new Error(
      `EDIT_BACKEND is set to "${process.env.EDIT_BACKEND}" in the environment — ` +
        `this acceptance run must exercise the DEFAULT, so unset it.`,
    );
  }
  if (config.editBackend !== "hyperframes") {
    throw new Error(`default EDIT_BACKEND is "${config.editBackend}", expected "hyperframes"`);
  }
  console.log(`acceptance: EDIT_BACKEND default is "${config.editBackend}" (unset in env)`);

  const runDir = join(args.runsRoot, args.runId);
  const { script, manifest } = await loadRun(runDir);

  const workRoot = join(args.outRoot, args.runId);
  const workspace = {
    root: workRoot,
    exports: join(workRoot, "exports"),
    checkpoints: join(workRoot, "checkpoints"),
  };
  for (const dir of [workspace.root, workspace.exports, workspace.checkpoints]) {
    await mkdir(dir, { recursive: true });
  }
  console.log(`acceptance: run ${args.runId} (${script.run_id}), ${script.beats.length} beats`);
  console.log(`acceptance: reading ${runDir} (read-only), writing ${workRoot}\n`);

  const log = (m: string): void => console.log(`  ${m}`);
  const timings: Record<string, number> = {};

  // ── EDIT: compose + draft render, as one review-loop iteration. ───────────
  let t = Date.now();
  const result = await build({ script, manifest, workspace, iteration: 1, onProgress: log });
  timings.draftBuildMs = Date.now() - t;
  console.log(`acceptance: draft build+render ${secs(timings.draftBuildMs)} -> ${result.exportPath}\n`);

  // ── The loop's finalizeMaster: high re-render of the winning checkpoint,
  //    then loudness normalisation into the master everything downstream uses.
  t = Date.now();
  const highExport = join(workspace.exports, `${script.run_id}-final-master-raw.mp4`);
  await renderFinalMaster({ checkpointPath: result.checkpointPath, exportPath: highExport, onProgress: log });
  const masterPath = join(workspace.exports, `${script.run_id}-master.mp4`);
  await normalizeLoudness(highExport, masterPath);
  timings.finalizeMasterMs = Date.now() - t;
  console.log(`acceptance: high render + loudness ${secs(timings.finalizeMasterMs)} -> ${masterPath}\n`);

  // ── REVIEW, Layer 1 only (see the header for why Layer 2 is skipped). ─────
  t = Date.now();
  const layer1 = await runLayer1(undefined, masterPath, script, log, result.plan, result.projectDir);
  timings.layer1Ms = Date.now() - t;
  for (const r of layer1) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
  }
  const failed = layer1.filter((r) => !r.passed).map((r) => r.name);
  console.log(
    `\nacceptance: layer 1 ${layer1.length - failed.length}/${layer1.length} passed in ` +
      `${secs(timings.layer1Ms)}${failed.length ? ` — failed: ${failed.join(", ")}` : ""}`,
  );

  // ── DELIVER's deterministic gate on the master. ───────────────────────────
  const container = layer1.find((r) => r.name === "container");
  const width = Number(container?.measured?.width ?? 0);
  const height = Number(container?.measured?.height ?? 0);
  const durationS = Number(container?.measured?.durationS ?? 0);
  const deliverable: string[] = [];
  if (width !== config.video.width || height !== config.video.height) {
    deliverable.push(`canvas is ${width}x${height}, not ${config.video.width}x${config.video.height}`);
  }
  const { min, max } = config.video.targetDurationS;
  if (durationS < min || durationS > max) {
    deliverable.push(`runs ${durationS.toFixed(1)}s, outside the ${min}-${max}s format window`);
  }
  console.log(
    `acceptance: deliverable — ${width}x${height}, ${durationS.toFixed(1)}s` +
      (deliverable.length ? ` — PROBLEMS: ${deliverable.join("; ")}` : " — OK"),
  );

  const summary = {
    runId: args.runId,
    editBackend: config.editBackend,
    palmierRunning: false,
    masterPath,
    projectDir: result.projectDir,
    layer1: layer1.map((r) => ({ name: r.name, passed: r.passed, detail: r.detail, measured: r.measured })),
    layer1Failed: failed,
    deliverableProblems: deliverable,
    layer2: "skipped — vision reviewer costs Bedrock calls and is untouched by this migration",
    timings,
    generatedAt: new Date().toISOString(),
  };
  const summaryPath = join(workRoot, "acceptance.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nacceptance: summary -> ${summaryPath}`);

  if (failed.length || deliverable.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
