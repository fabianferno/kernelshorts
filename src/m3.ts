import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fetchFrontPage, filterStories, dedupeAgainstPublished, fetchComments } from "./research/hn.js";
import { rankStories } from "./research/rank.js";
import { fetchSources } from "./research/fetch-source.js";
import { buildBrief } from "./research/brief.js";
import { generateScript, UnsourceableScriptError } from "./research/script.js";
import { synthesize } from "./tts/soniox.js";
import { acquireAssets } from "./assets/acquire.js";
import { createWorkspace, initState, setPhase, saveState, emit, recordCost } from "./run/workspace.js";
import { openGate, supersedeOlderGates } from "./run/gates.js";
import { closeDb } from "./db/mongo.js";
import { config } from "./config.js";
import type { VoiceoverClip } from "./shared/schemas.js";

/**
 * M3 (PRD §7): the research phase — a real HN topic, researched from real
 * pages, fact-checked against them, scripted, voiced, and staged for Gate A.
 *
 * This is what replaces the hand-written ScriptJSON at the top of src/m1.ts.
 * Everything downstream of Gate A (edit, review, export) is M1/M2 and unchanged.
 *
 * Run: npx tsx src/m3.ts [voiceName]
 */

/** Sentinel so the escalation path exits cleanly without being re-reported as
 *  an unexpected crash. */
class GateEscalation extends Error {}

const VOICE = process.argv[2] ?? "Emma";
const TARGET_DURATION_S = 45;
/** Ranked candidates surfaced to the dashboard (PRD §3.3: "top 3"). */
const SHORTLIST = 3;

const slug = new Date().toISOString().slice(0, 10);
const runId = `hn-${slug}`;
const ws = await createWorkspace(runId, slug);
let state = await initState(ws);

console.log(`run: ${runId}\nworkspace: ${ws.root}\nvoice: ${VOICE}\n`);

try {
  await supersedeOlderGates(runId);

  // ── Ingest → filter → dedupe (PRD §3.1–3.2) ──────────────────────────────
  state = await setPhase(ws, state, "research");
  const front = await fetchFrontPage(24);
  const filtered = filterStories(front);
  const deduped = await dedupeAgainstPublished(filtered.kept);
  console.log(
    `HN: ${front.length} stories → ${filtered.kept.length} after filter ` +
      `(${filtered.dropped.length} dropped) → ${deduped.kept.length} after dedupe ` +
      `(${deduped.dropped.length} already published)`,
  );
  if (deduped.kept.length === 0) {
    throw new Error(
      "No eligible HN story today. Every front-page item was filtered out or " +
        "already published — this is a real empty day, not an error to route around.",
    );
  }

  // ── Rank (PRD §3.3) ──────────────────────────────────────────────────────
  const ranked = await rankStories(deduped.kept);
  state = await recordCost(ws, state, "research", {
    inputTokens: ranked.inputTokens,
    outputTokens: ranked.outputTokens,
    wallClockMs: 0,
  });
  if (ranked.ranked.length === 0) {
    throw new Error(`Ranking produced nothing usable: ${ranked.unranked.length} unranked`);
  }
  const shortlist = ranked.ranked.slice(0, SHORTLIST);
  console.log("\nshortlist:");
  for (const [i, r] of shortlist.entries()) {
    console.log(`  ${i + 1}. ${r.score.toFixed(2)}  ${r.story.title}`);
  }
  const pick = shortlist[0]!;
  await emit(runId, "research", "artifact", `picked: ${pick.story.title}`, pick);

  // ── Research: real pages, real comments (PRD §3.4) ───────────────────────
  const comments = pick.story.id ? await fetchComments(pick.story.id) : [];
  const urls = [pick.story.url, pick.story.hn_url].filter((u): u is string => !!u);
  const fetched = await fetchSources(urls);
  for (const e of fetched.errors) console.log(`  source failed: ${e.url} — ${e.error}`);
  if (fetched.sources.length === 0) {
    throw new Error(
      `Could not fetch any source for "${pick.story.title}". Researching a topic ` +
        `whose pages we cannot read would mean inventing the content.`,
    );
  }
  console.log(
    `\nsources: ${fetched.sources
      .map((s) => `${s.url} (${s.text.length} chars)`)
      .join("\n         ")}`,
  );

  const briefResult = await buildBrief({
    story: {
      hn_id: pick.story.id,
      title: pick.story.title,
      url: pick.story.url ?? pick.story.hn_url,
      points: pick.story.points,
    },
    comments,
    sources: fetched.sources,
  });
  state = await recordCost(ws, state, "research", {
    inputTokens: briefResult.inputTokens,
    outputTokens: briefResult.outputTokens,
    wallClockMs: briefResult.latencyMs,
  });
  const briefPath = join(ws.root, "brief.json");
  await writeFile(briefPath, JSON.stringify(briefResult.brief, null, 2));
  console.log(
    `\nbrief: ${briefResult.brief.claims.length} claims from ` +
      `${briefResult.candidateClaims} candidates, ${briefResult.calls} calls`,
  );

  // ── Script + fact-check loop (PRD §3.5–3.6) ──────────────────────────────
  state = await setPhase(ws, state, "script");
  const sourceTexts = fetched.sources.map((s) => ({ url: s.url, text: s.text }));
  let scripted;
  try {
    scripted = await generateScript({
      runId,
      story: {
        hn_id: pick.story.id,
        title: pick.story.title,
        url: pick.story.url ?? pick.story.hn_url,
      },
      brief: briefResult.brief,
      sources: sourceTexts,
      targetDurationS: TARGET_DURATION_S,
    });
  } catch (err) {
    // An unsourceable script is exactly the case the PRD says to escalate
    // rather than publish (§3.5). The gate carries the failing lines.
    if (err instanceof UnsourceableScriptError) {
      await openGate(runId, "A_script", {
        outcome: "escalated",
        reason: "fact-check failed after 2 rewrites",
        problems: err.report.problems,
        script: err.script,
        factCheck: err.report,
      });
      await saveState(ws, { ...state, phase: "failed", blocked_on: err.message });
      console.error(`\nESCALATED to Gate A — fact-check failed:\n${err.message}`);
      process.exitCode = 1;
      throw new GateEscalation();
    }
    throw err;
  }

  state = await recordCost(ws, state, "script", {
    inputTokens: scripted.inputTokens,
    outputTokens: scripted.outputTokens,
    wallClockMs: 0,
  });
  const script = scripted.script;
  console.log(
    `\nscript: ${script.beats.length} beats, fact-check passed on attempt ` +
      `${scripted.attempts}, ${script.claims.length} sourced claim(s)`,
  );
  for (const line of scripted.factCheck.lines) {
    console.log(`  [${line.status}] ${line.beat_id}: ${line.vo_text}`);
  }
  await writeFile(join(ws.root, "script.json"), JSON.stringify(script, null, 2));
  await writeFile(
    join(ws.root, "factcheck.json"),
    JSON.stringify(scripted.factCheck, null, 2),
  );

  // ── TTS: audio-first, real measured durations (PRD §3.7) ─────────────────
  state = await setPhase(ws, state, "tts");
  const voiceover: VoiceoverClip[] = [];
  for (const beat of script.beats) {
    const clip = await synthesize({
      text: beat.vo_text,
      voice: VOICE,
      outPath: join(ws.vo, `${beat.id}.wav`),
    });
    voiceover.push({
      beat_id: beat.id,
      path: clip.path,
      durationS: clip.durationS,
      voice: clip.voice,
      model: clip.model,
    });
  }
  const voTotal = voiceover.reduce((s, v) => s + v.durationS, 0);
  // The finished video is a little longer than the VO (the last beat holds
  // briefly), but not by much — so a VO outside the format window means the
  // short will be too. Reported at the gate rather than silently accepted:
  // the first real passing run came in at 28.8s against a 30s floor, because
  // the fact-check rewrite dropped a beat and nothing downstream noticed.
  const { min, max } = config.video.targetDurationS;
  const durationWarning =
    voTotal < min
      ? `VO totals ${voTotal.toFixed(1)}s, under the ${min}s floor — the script ` +
        `lost length to the fact-check rewrite and needs another beat.`
      : voTotal > max
        ? `VO totals ${voTotal.toFixed(1)}s, over the ${max}s ceiling — trim a beat.`
        : undefined;
  console.log(
    `\nVO total: ${voTotal.toFixed(1)}s (target ${TARGET_DURATION_S}s, ` +
      `format window ${min}-${max}s)` + (durationWarning ? `\n  WARNING: ${durationWarning}` : ""),
  );
  if (durationWarning) await emit(runId, "tts", "log", durationWarning);

  // ── Asset manifest (PRD §3.8) ────────────────────────────────────────────
  state = await setPhase(ws, state, "assets");
  const manifest = await acquireAssets(script, ws.root, { voiceover });
  for (const a of manifest.assets) {
    console.log(`  ${a.beat_id}: ${a.kind} ${a.width}x${a.height} (${a.license.provider})`);
  }
  state = await saveState(ws, { ...state, script, manifest });

  // ── Gate A (PRD §3): a human approves the script before anything is cut. ─
  await openGate(runId, "A_script", {
    shortlist: shortlist.map((r) => ({
      title: r.story.title,
      url: r.story.url,
      score: r.score,
      justification: r.justification,
    })),
    brief: briefResult.brief,
    script,
    factCheck: scripted.factCheck,
    voiceover: voiceover.map((v) => ({ beat_id: v.beat_id, path: v.path, durationS: v.durationS })),
    assets: manifest.assets.map((a) => ({ beat_id: a.beat_id, kind: a.kind, path: a.path })),
    voTotalS: Number(voTotal.toFixed(2)),
    durationWarning,
  });

  console.log(
    `\n=== GATE A OPEN ===\n` +
      `script:    ${join(ws.root, "script.json")}\n` +
      `brief:     ${briefPath}\n` +
      `factcheck: ${join(ws.root, "factcheck.json")}\n` +
      `voiceover: ${ws.vo}\n\n` +
      `The run stops here until a human approves. Nothing auto-approves; ` +
      `resolve it with resolveGate("${runId}", "A_script", "approved").`,
  );
} catch (err) {
  if (!(err instanceof GateEscalation)) {
    const message = err instanceof Error ? err.message : String(err);
    await emit(runId, state.phase, "error", message);
    await saveState(ws, { ...state, phase: "failed", blocked_on: message });
    console.error(`\nFAILED in phase "${state.phase}": ${message}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
