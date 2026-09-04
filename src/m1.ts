import { join } from "node:path";
import { ScriptJSON, type VoiceoverClip } from "./shared/schemas.js";
import { synthesize } from "./tts/soniox.js";
import { acquireAssets } from "./assets/acquire.js";
import { buildTimeline } from "./edit/build-timeline.js";
import { build as buildHyperframes } from "./edit/build.js";
import { PalmierClient } from "./palmier/client.js";
import { createWorkspace, initState, setPhase, saveState, emit } from "./run/workspace.js";
import {
  checkContainer, checkLoudness, checkBlackFrames, checkFrozenFrames, normalizeLoudness,
} from "./verify/media.js";
import { closeDb } from "./db/mongo.js";
import { config } from "./config.js";

/**
 * M1 (PRD §7): hardcoded ScriptJSON + real assets → finished 9:16 video.
 * This is the risk core, so it runs the real path end to end — real TTS, real
 * Playwright recordings, real stock, the live Palmier MCP, a real export.
 *
 * Run: npx tsx src/m1.ts [voiceName]
 */

const RUN_ID = `m1-${new Date().toISOString().slice(0, 10)}`;

/** A real HN front-page topic, hand-written for M1 rather than LLM-generated —
 *  the research phase that produces this arrives in M3. */
const SCRIPT: ScriptJSON = ScriptJSON.parse({
  run_id: RUN_ID,
  topic: {
    title: "Hacker News: the front page that runs the industry's attention",
    url: "https://news.ycombinator.com",
  },
  target_duration_s: 35,
  music_mood: "upbeat-tech",
  beats: [
    {
      id: "hook",
      vo_text: "Every morning, one plain text page decides what half of tech talks about.",
      // Image overlay instead of a title: the real HN logo says "Hacker News"
      // faster than any words could. Served as SVG, which neither Palmier nor
      // ffmpeg can read — acquisition rasterizes it with rsvg-convert.
      on_screen_image: {
        source: "https://news.ycombinator.com/y18.svg",
        scale: 0.28,
        centerY: 0.2,
      },
      visual: {
        type: "screenrec",
        url: "https://news.ycombinator.com",
        viewport: "mobile",
        actions: ["goto", "wait 900", "scroll 700"],
      },
      max_duration_s: 6,
    },
    {
      id: "what",
      vo_text:
        "Hacker News has no algorithm chasing your attention. Stories rise on votes and fall on time.",
      on_screen_text: "Votes up. Time down.",
      visual: {
        type: "screenrec",
        url: "https://news.ycombinator.com/newest",
        viewport: "mobile",
        actions: ["goto", "wait 900", "scroll 500"],
      },
      max_duration_s: 8,
    },
    {
      id: "why",
      vo_text:
        "That single ranking rule is why a weekend project can outrank a billion dollar launch.",
      on_screen_text: "Weekend project > billion dollar launch",
      visual: { type: "stock", query: "developer coding late night", preferVault: true },
      max_duration_s: 8,
    },
    {
      id: "how",
      vo_text:
        "Points divided by the age of the post, raised to a power. That's the whole formula. It has barely changed in eighteen years.",
      on_screen_text: "points / age^gravity",
      visual: {
        type: "screenrec",
        url: "https://news.ycombinator.com/newsfaq.html",
        viewport: "mobile",
        actions: ["goto", "wait 900", "scroll 400"],
      },
      max_duration_s: 10,
    },
    {
      id: "so",
      vo_text:
        "So if you want to know what engineers will be arguing about next month, this is where it starts.",
      visual: { type: "stock", query: "team collaborating office night", preferVault: true },
      max_duration_s: 8,
    },
    {
      id: "cta",
      vo_text: "Follow for the best of Hacker News, every single day.",
      on_screen_text: "Follow for daily HN finds",
      visual: { type: "stock", query: "city lights time lapse night", preferVault: true },
      max_duration_s: 5,
    },
  ],
  claims: [
    {
      text: "Hacker News ranks stories by points divided by a power of the time since submission.",
      source_url: "https://news.ycombinator.com/newsfaq.html",
      excerpt:
        "How are stories ranked? The basic algorithm divides points by a power of the time since a story was submitted.",
    },
  ],
  cta: {
    vo_text: "Follow for the best of Hacker News, every single day.",
    on_screen_text: "Follow for daily HN finds",
  },
});

const voiceName = process.argv[2] ?? "Fabian";

const ws = await createWorkspace(SCRIPT.run_id);
let state = await initState(ws);
console.log(`workspace: ${ws.root}\nvoice: ${voiceName}\n`);

try {
  // ── TTS: audio-first. Measured durations define every beat boundary. ──────
  state = await setPhase(ws, state, "tts");
  const voiceover: VoiceoverClip[] = [];
  for (const beat of SCRIPT.beats) {
    const clip = await synthesize({
      text: beat.vo_text,
      voice: voiceName,
      outPath: join(ws.vo, `${beat.id}.wav`),
    });
    voiceover.push({
      beat_id: beat.id,
      path: clip.path,
      durationS: clip.durationS,
      voice: clip.voice,
      model: clip.model,
    });
    await emit(SCRIPT.run_id, "tts", "artifact", `VO ${beat.id}: ${clip.durationS.toFixed(2)}s`);
  }
  const voTotal = voiceover.reduce((sum, v) => sum + v.durationS, 0);
  console.log(`\nVO total: ${voTotal.toFixed(1)}s\n`);

  // ── Assets: real recordings, real stock, real licensed music. ─────────────
  state = await setPhase(ws, state, "assets");
  const manifest = await acquireAssets(SCRIPT, ws.root, { voiceover });
  for (const a of manifest.assets) {
    await emit(
      SCRIPT.run_id, "assets", "artifact",
      `${a.beat_id}: ${a.kind} ${a.width}x${a.height} ${a.durationS?.toFixed(1)}s (${a.license.provider})`,
    );
  }
  if (manifest.music) console.log(`music: ${manifest.music.name}`);
  state = await saveState(ws, { ...state, script: SCRIPT, manifest });

  // ── Edit: either the live Palmier MCP, or the headless hyperframes
  //    backend, per EDIT_BACKEND. ─────────────────────────────────────────
  state = await setPhase(ws, state, "edit");
  let build: { exportPath: string; checkpointPath: string; projectDir: string };
  if (config.editBackend === "hyperframes") {
    build = await buildHyperframes({
      script: SCRIPT,
      manifest,
      workspace: ws,
      iteration: 1,
      final: true,
      onProgress: (m) => console.log(`  edit: ${m}`),
    });
  } else {
    const client = new PalmierClient();
    await client.connect();
    try {
      const palmierBuild = await buildTimeline({
        client,
        script: SCRIPT,
        manifest,
        workspace: ws,
        onProgress: (m) => console.log(`  edit: ${m}`),
      });
      build = { ...palmierBuild, projectDir: palmierBuild.projectPath };
    } finally {
      await client.close();
    }
  }
  state = await saveState(ws, {
    ...state,
    // Key kept as `palmier_project_path` for now — Task 11 renames it.
    palmier_project_path: build.projectDir,
    exports: [build.exportPath],
  });

  // ── Verify + normalize. Palmier's raw export is never the master (M0). ────
  state = await setPhase(ws, state, "export");
  console.log("\nLayer-1 verifiers on the raw export:");
  for (const check of [checkContainer, checkLoudness, checkBlackFrames, checkFrozenFrames]) {
    const r = await check(build.exportPath);
    console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  }

  const masterPath = join(ws.exports, `${SCRIPT.run_id}-master.mp4`);
  const norm = await normalizeLoudness(build.exportPath, masterPath);
  console.log(
    `\nnormalized ${norm.before.integratedLufs} → ${norm.after.integratedLufs} LUFS`,
  );

  console.log("\nLayer-1 verifiers on the publish master:");
  const results = [];
  for (const check of [checkContainer, checkLoudness, checkBlackFrames, checkFrozenFrames]) {
    const r = await check(masterPath);
    results.push(r);
    console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  }

  state = await saveState(ws, {
    ...state,
    exports: [build.exportPath, masterPath],
    phase: results.every((r) => r.passed) ? "done" : "review",
  });

  console.log(`\nmaster:     ${masterPath}`);
  console.log(`checkpoint: ${build.checkpointPath}`);
  console.log(`project:    ${build.projectDir}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await emit(SCRIPT.run_id, state.phase, "error", message);
  await saveState(ws, { ...state, phase: "failed", blocked_on: message });
  console.error(`\nFAILED in phase "${state.phase}": ${message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
