import { readdir, readFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { produceVoiceAndAssets } from "./produce.js";
import { runReviewLoop } from "../review/loop.js";
import { build } from "../edit/build.js";
import { loadCharacter } from "../host/characters.js";
import { acquireGenerated } from "../assets/acquire.js";
import { themesForBeats } from "../edit/studio.js";
import { AssetManifest as AssetManifestSchema } from "../shared/schemas.js";
import { createWorkspace, initState, loadState, setPhase, saveState, emit } from "./workspace.js";
import { putArtifact } from "./artifacts.js";
import { notify } from "../notify/push.js";
import { config } from "../config.js";
import { RunState, ScriptJSON, type AssetManifest } from "../shared/schemas.js";

/**
 * One run, end to end: a script you provide → voiceover → assets → edit →
 * review loop → a finished 9:16 video in ~/pipeline/out.
 *
 * Shared by the long-running server (src/server.ts) and the one-shot CLI
 * (src/pipeline.ts) so both drive the same code.
 *
 * Never calls process.exit and never throws for an ordinary bad outcome: a
 * failed phase is a RESULT, so the daemon survives it.
 */

export const DEFAULT_VOICE = config.elevenlabs.voiceId;

/** One flat folder of finished videos. */
export const OUT_DIR = join(process.env.HOME ?? "~", "pipeline", "out");

export interface ExecuteRunOptions {
  /** Required for a new run. Ignored when resuming (the saved script is used). */
  script?: ScriptJSON;
  /** ElevenLabs voice_id. */
  voice?: string;
  /** Re-enter a run whose voiceover and assets are already on disk. */
  resume?: boolean;
  runId?: string;
  dateSlug?: string;
  onProgress?: (message: string) => void;
  /** See LoopOptions.reviewer. /reel runs use "self". */
  reviewer?: "bedrock" | "self";
  /** Stop once voiceover + assets exist (approval point before rendering). */
  stopAfterAssets?: boolean;
  /** Render only the first 10 s (Gate 2) and stop. Requires voice + assets. */
  hookOnly?: boolean;
  /** Host character id; also picks the voice unless `voice` is given. */
  character?: string;
  /** Resume only: re-render generated/3D scenes with the current code (no TTS spend). */
  refreshScenes?: boolean;
}

/** Seconds rendered for the Gate-2 hook check. */
export const HOOK_SECONDS = 10;

export type ExecuteRunResult =
  | { status: "done"; runId: string; outPath: string; escalated: boolean; reason?: string }
  | { status: "assets_ready"; runId: string; workspace: string; voTotalS: number; durationWarning?: string }
  | { status: "hook_ready"; runId: string; hookPath: string }
  | { status: "failed"; runId: string; phase: string; reason: string };

/** Filesystem- and id-safe slug. */
export function slugify(s: string, max = 48): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "video"
  );
}

/**
 * Finds a run that got as far as a script + manifest but never finished —
 * resuming it skips the TTS and asset spend.
 */
export async function findResumableRun(): Promise<RunState | undefined> {
  if (!existsSync(config.paths.runsRoot)) return undefined;
  const slugs = (await readdir(config.paths.runsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  for (const slug of slugs) {
    const statePath = join(config.paths.runsRoot, slug, "state.json");
    if (!existsSync(statePath)) continue;
    let state: RunState;
    try {
      state = RunState.parse(JSON.parse(await readFile(statePath, "utf8")));
    } catch {
      continue;
    }
    if (["publish", "done"].includes(state.phase)) continue;
    if (!state.script || !state.manifest) continue;
    return state;
  }
  return undefined;
}

/**
 * Ids for a new run. The slug carries the time, not just the date, because a
 * content hub makes several videos a day — the old one-run-per-day key would
 * have them overwrite each other's workspace.
 */
export function newRunIds(script?: ScriptJSON): { runId: string; dateSlug: string } {
  const now = new Date().toISOString();
  const dateSlug = `${now.slice(0, 10)}-${now.slice(11, 19).replace(/:/g, "")}`;
  const runId = script ? `${slugify(script.topic.title, 32)}-${dateSlug}` : `run-${dateSlug}`;
  return { runId, dateSlug };
}

export async function executeRun(opts: ExecuteRunOptions = {}): Promise<ExecuteRunResult> {
  // Character → voice: a female host speaks with a female voice, etc. The
  // script may name its character; --character overrides; --voice overrides both.
  const characterId = opts.character ?? opts.script?.character;
  const character = loadCharacter(characterId);
  const voice = opts.voice ?? character.voice.voiceId;
  const fresh = newRunIds(opts.script);
  const slug = opts.dateSlug ?? fresh.dateSlug;
  const runId = opts.runId ?? fresh.runId;
  const log = opts.onProgress ?? (() => {});

  if (!opts.resume && !opts.script) {
    return { status: "failed", runId, phase: "tts", reason: "a new run needs a script" };
  }

  const ws = await createWorkspace(runId, slug);
  let state = opts.resume ? await loadState(ws) : undefined;
  if (opts.resume && !state) {
    return {
      status: "failed",
      runId,
      phase: "tts",
      reason: `resume found no state at ${ws.statePath}; start a new run instead.`,
    };
  }
  state ??= await initState(ws);

  log(`run: ${runId}\nworkspace: ${ws.root}\nhost: ${character.name} (${character.id})\nvoice: ${voice}\n`);

  try {
    let script: ScriptJSON;
    let manifest: AssetManifest;

    if (opts.resume) {
      if (!state.script || !state.manifest) {
        return {
          status: "failed",
          runId,
          phase: state.phase,
          reason: `resume: run ${runId} has no script/manifest yet — nothing to edit.`,
        };
      }
      script = state.script;
      manifest = state.manifest;
      log(`resuming: ${script.topic.title}`);
      if (opts.refreshScenes) {
        const themes = themesForBeats(script.beats);
        const assets = [];
        for (const a of manifest.assets) {
          const i = script.beats.findIndex((b) => b.id === a.beat_id);
          const beat = script.beats[i];
          const vo = manifest.voiceover.find((v) => v.beat_id === a.beat_id);
          if (beat?.visual.type === "generated" && vo) {
            log(`  re-rendering scene ${beat.id} (${themes[i]})`);
            assets.push(await acquireGenerated(beat.visual.spec, ws.root, beat.id, vo.durationS, themes[i]));
          } else assets.push(a);
        }
        manifest = AssetManifestSchema.parse({ ...manifest, assets });
        state = await saveState(ws, { ...state, manifest });
      }
    } else {
      // The edit phase keys files off script.run_id, so it must match the run.
      script = ScriptJSON.parse({ ...opts.script, run_id: runId, character: character.id });
      const produced = await produceVoiceAndAssets({ runId, ws, state, script, voice, onProgress: log });
      state = produced.state;
      manifest = produced.manifest;
      if (opts.stopAfterAssets) {
        log(`\n=== VOICE + ASSETS READY (${produced.voTotalS}s) — stopping before the edit ===`);
        return {
          status: "assets_ready",
          runId,
          workspace: ws.root,
          voTotalS: produced.voTotalS,
          durationWarning: produced.durationWarning,
        };
      }
    }


    // ── Gate 2: only the hook, rendered on its own. ────────────────────────
    if (opts.hookOnly) {
      state = await setPhase(ws, state, "edit");
      const hook = await build({
        script,
        manifest,
        workspace: ws,
        iteration: 0,
        character: script.character ?? character.id,
        maxSeconds: HOOK_SECONDS,
        exportName: `${runId}-hook.mp4`,
        onProgress: log,
      });
      log(`\n=== HOOK READY ===\n${hook.exportPath}`);
      return { status: "hook_ready", runId, hookPath: hook.exportPath };
    }

    // ── Edit + review loop. Renders headlessly. ────────────────────────────
    state = await setPhase(ws, state, "edit");
    const outcome = await runReviewLoop({
      script,
      manifest,
      workspace: ws,
      onProgress: log,
      reviewer: opts.reviewer,
      character: script.character ?? character.id,
    });

    log(`\n=== REVIEW ${outcome.status.toUpperCase()} ===`);
    for (const it of outcome.iterations) {
      const failed = it.layer1.filter((r) => !r.passed).map((r) => r.name);
      log(
        `  #${it.index}` +
          (it.meanScore === undefined ? " (self-review)" : ` mean ${it.meanScore.toFixed(2)}`) +
          ` L1 ${it.layer1.length - failed.length}/${it.layer1.length}` +
          (failed.length ? ` FAILED: ${failed.join(",")}` : ""),
      );
    }

    // ── Output: copy the final master to one predictable folder. ───────────
    state = await setPhase(ws, state, "export");
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, `${runId}.mp4`);
    await copyFile(outcome.final.masterPath, outPath);
    await putArtifact(runId, outPath, { kind: "export", phase: "export", label: "final" });

    await saveState(ws, {
      ...state,
      iterations: outcome.iterations.length,
      exports: [...outcome.iterations.map((i) => i.masterPath), outPath],
      phase: "done",
    });

    const escalated = outcome.status === "escalate";
    const reason = escalated ? outcome.reason : undefined;
    await emit(runId, "done", "log", `finished: ${outPath}` + (escalated ? ` (review escalated: ${reason})` : ""));
    await notify({ title: `Video ready: ${script.topic.title}`, body: outPath });
    log(
      `\n=== DONE ===\nvideo: ${outPath}\n` +
        (escalated
          ? `NOTE: the review loop escalated (${reason}) — the video is playable but ` +
            `did not clear the rubric on its own. Watch it.\n`
          : ""),
    );

    return { status: "done", runId, outPath, escalated, reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emit(runId, state.phase, "error", message);
    await saveState(ws, { ...state, phase: "failed", blocked_on: message });
    await notify({ title: `Run ${runId} FAILED`, body: `${state.phase}: ${message}` });
    log(`\nFAILED in phase "${state.phase}": ${message}`);
    return { status: "failed", runId, phase: state.phase, reason: message };
  }
}
