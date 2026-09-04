import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  fetchFrontPage,
  filterStories,
  dedupeAgainstPublished,
  fetchComments,
  HnStory as HnStorySchema,
  type HnStory,
} from "../research/hn.js";
import { rankStories, type RankedStory } from "../research/rank.js";
import { fetchSources } from "../research/fetch-source.js";
import { buildBrief, ResearchBrief as ResearchBriefSchema, type ResearchBrief } from "../research/brief.js";
import { generateScript, UnsourceableScriptError } from "../research/script.js";
import { synthesize } from "../tts/soniox.js";
import { acquireAssets } from "../assets/acquire.js";
import { setPhase, saveState, emit, recordCost, type Workspace } from "../run/workspace.js";
import { openGate } from "../run/gates.js";
import { putArtifact } from "../run/artifacts.js";
import { notify } from "../notify/push.js";
import { config } from "../config.js";
import type {
  AssetManifest,
  RunState,
  ScriptJSON,
  VoiceoverClip,
} from "../shared/schemas.js";
import type { FactCheckReport } from "../research/factcheck.js";

/**
 * Phase 1 (PRD §3), extracted from src/m3.ts so the milestone driver and the
 * full daily pipeline run the SAME code.
 *
 * The alternative was for src/pipeline.ts to re-implement the orchestration,
 * which would mean two copies of the fact-check loop and the Gate A payload
 * drifting apart — and the copy that runs daily would be the one nobody tested.
 */

/** Ranked candidates surfaced to the dashboard (PRD §3.3: "top 3"). */
const SHORTLIST = 3;

/**
 * Everything from ingest up to and including the brief, cached on disk.
 *
 * That span is the expensive, re-derivable half of research: an HN fetch, an
 * LLM ranking pass, source downloads, comment fetch, and the claim extraction
 * that costs ~5 model calls. The half AFTER it — script generation and the
 * fact-check loop — is the half that fails, and it used to take all of the
 * above down with it. A rerun then paid for the identical brief a second time.
 *
 * Keyed to the run, so it only ever shortcuts a retry of the SAME day. It
 * deliberately stores the source TEXT, not just the urls: re-fetching would
 * reintroduce the network and, worse, could return different page content and
 * silently invalidate the claims the brief already verified against it.
 */
const ResearchCheckpoint = z.object({
  version: z.literal(1),
  run_id: z.string(),
  saved_at: z.string(),
  story: HnStorySchema,
  shortlist: z.array(
    z.object({
      story: HnStorySchema,
      score: z.number(),
      justification: z.string().default(""),
      scores: z.record(z.string(), z.number()).default({}),
    }),
  ),
  sources: z.array(z.object({ url: z.string(), text: z.string() })),
  comments: z.array(z.string()).default([]),
  brief: ResearchBriefSchema,
});
type ResearchCheckpoint = z.infer<typeof ResearchCheckpoint>;

function checkpointPath(ws: Workspace): string {
  return join(ws.checkpoints, "research.json");
}

/**
 * Reads the checkpoint, or returns undefined for ANY reason it cannot be used.
 *
 * A corrupt or stale checkpoint must never fail a run: the whole point is to
 * save money on a retry, and the fallback — doing the research again — is
 * exactly what would have happened without it. Failing loudly here would turn
 * an optimisation into a new way for the pipeline to break.
 */
async function loadCheckpoint(
  ws: Workspace,
  runId: string,
  log: (m: string) => void,
): Promise<ResearchCheckpoint | undefined> {
  const path = checkpointPath(ws);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = ResearchCheckpoint.parse(JSON.parse(await readFile(path, "utf8")));
    if (parsed.run_id !== runId) return undefined;
    return parsed;
  } catch (err) {
    log(`  research checkpoint unusable, redoing research: ${(err as Error).message}`);
    return undefined;
  }
}

export interface ResearchOptions {
  runId: string;
  ws: Workspace;
  state: RunState;
  voice: string;
  targetDurationS: number;
  onProgress?: (message: string) => void;
  /**
   * Asked when the script cannot be made sourceable, AFTER Gate A has been
   * opened with the failing lines. Return true to carry on with the flagged
   * script, false to stop the run.
   *
   * This exists because "escalate" used to mean "throw, and exit": the gate was
   * opened for a human and then nobody was left listening to their answer. A
   * caller that can wait (the daemon) supplies this; a caller that cannot (the
   * m3 driver) omits it and keeps the old exit-on-escalation behaviour.
   */
  onEscalation?: (info: {
    message: string;
    problems: string[];
    script: ScriptJSON;
    factCheck: FactCheckReport;
  }) => Promise<boolean>;
}

export interface ResearchResult {
  state: RunState;
  script: ScriptJSON;
  manifest: AssetManifest;
  brief: ResearchBrief;
  factCheck: FactCheckReport;
  voiceover: VoiceoverClip[];
  story: HnStory;
  shortlist: RankedStory[];
  voTotalS: number;
  durationWarning?: string;
  /**
   * Set only when a human approved a script the fact-checker rejected. These
   * lines are narrated in the finished video with no source behind them, so
   * they are carried all the way to Gate C rather than being forgotten the
   * moment the gate closed.
   */
  unsourcedLines?: string[];
}

/**
 * Thrown when the topic could be researched but not honestly scripted. Carries
 * everything Gate A needs to show a human what failed; the gate is already open
 * by the time this is thrown.
 */
export class ResearchEscalation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchEscalation";
  }
}

/**
 * Runs ingest → filter → dedupe → rank → research → script → TTS → assets and
 * leaves Gate A OPEN. Waiting on the gate is the caller's job: the milestone
 * driver and the daily pipeline want different behaviour there (one can exit,
 * the other has to carry on into the edit).
 */
export async function runResearchPhase(opts: ResearchOptions): Promise<ResearchResult> {
  const { runId, ws, voice, targetDurationS } = opts;
  const log = opts.onProgress ?? (() => {});
  let state = opts.state;

  // ── Ingest → filter → dedupe (PRD §3.1–3.2) ────────────────────────────────
  state = await setPhase(ws, state, "research");

  const cached = await loadCheckpoint(ws, runId, log);
  let pickedStory: HnStory;
  let shortlist: RankedStory[];
  let sourceTexts: Array<{ url: string; text: string }>;
  let brief: ResearchBrief;

  if (cached) {
    log(
      `reusing research checkpoint from ${cached.saved_at} — "${cached.story.title}" ` +
        `with ${cached.brief.claims.length} verified claim(s). Skipping HN ingest, ` +
        `ranking, source fetch and brief extraction.`,
    );
    await emit(runId, "research", "log", `research checkpoint reused (${cached.story.title})`);
    pickedStory = cached.story;
    shortlist = cached.shortlist as unknown as RankedStory[];
    sourceTexts = cached.sources;
    brief = cached.brief;
    // Rewritten rather than assumed: putArtifact uploads brief.json from disk
    // later, and a checkpointed run whose workspace was partly cleaned would
    // otherwise fail there instead of here.
    await writeFile(join(ws.root, "brief.json"), JSON.stringify(brief, null, 2));
  } else {
  const front = await fetchFrontPage(24);
  const filtered = filterStories(front);
  const deduped = await dedupeAgainstPublished(filtered.kept);
  log(
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

  // ── Rank (PRD §3.3) ────────────────────────────────────────────────────────
  const ranked = await rankStories(deduped.kept);
  state = await recordCost(ws, state, "research", {
    inputTokens: ranked.inputTokens,
    outputTokens: ranked.outputTokens,
    wallClockMs: 0,
  });
  if (ranked.ranked.length === 0) {
    throw new Error(
      `Ranking produced nothing usable: ${ranked.unranked.length} unranked. ` +
        `If they were all dropped for topical_fit, today's front page simply had ` +
        `no software story worth making.`,
    );
  }
  shortlist = ranked.ranked.slice(0, SHORTLIST);
  log("shortlist:");
  for (const [i, r] of shortlist.entries()) {
    log(`  ${i + 1}. ${r.score.toFixed(2)}  ${r.story.title}`);
  }
  const pick = shortlist[0]!;
  pickedStory = pick.story;
  await emit(runId, "research", "artifact", `picked: ${pick.story.title}`, pick);

  // ── Research: real pages, real comments (PRD §3.4) ─────────────────────────
  const comments = pick.story.id ? await fetchComments(pick.story.id) : [];
  const urls = [pick.story.url, pick.story.hn_url].filter((u): u is string => !!u);
  const fetched = await fetchSources(urls);
  for (const e of fetched.errors) log(`  source failed: ${e.url} — ${e.error}`);
  if (fetched.sources.length === 0) {
    throw new Error(
      `Could not fetch any source for "${pick.story.title}". Researching a topic ` +
        `whose pages we cannot read would mean inventing the content.`,
    );
  }
  for (const s of fetched.sources) log(`  source: ${s.url} (${s.text.length} chars)`);

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
  log(
    `brief: ${briefResult.brief.claims.length} claims from ` +
      `${briefResult.candidateClaims} candidates, ${briefResult.calls} calls`,
  );

  sourceTexts = fetched.sources.map((s) => ({ url: s.url, text: s.text }));
  brief = briefResult.brief;

  // Written HERE, before the script step that is the one likely to fail, so
  // the failure has something to fall back to. Saving it after the script
  // succeeded would checkpoint only the runs that never needed a checkpoint.
  await writeFile(
    checkpointPath(ws),
    JSON.stringify(
      {
        version: 1,
        run_id: runId,
        saved_at: new Date().toISOString(),
        story: pickedStory,
        shortlist,
        sources: sourceTexts,
        comments,
        brief,
      },
      null,
      2,
    ),
  );
  log(`research checkpoint saved — a retry today skips straight to scripting`);
  }

  // ── Script + fact-check loop (PRD §3.5–3.6) ────────────────────────────────
  state = await setPhase(ws, state, "script");
  let scripted;
  /** Populated only when a human waved an unsourceable script through. */
  let unsourcedLines: string[] | undefined;
  try {
    scripted = await generateScript({
      runId,
      story: {
        hn_id: pickedStory.id,
        title: pickedStory.title,
        url: pickedStory.url ?? pickedStory.hn_url,
      },
      brief,
      sources: sourceTexts,
      targetDurationS,
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
      await notify({
        title: `Run ${runId} escalated`,
        body: `Fact-check failed after 2 rewrites — Gate A needs a human.`,
      });

      // The gate is open. Whether anyone is still here to hear the answer is
      // the caller's business: without a resolver this stays what it always
      // was — a run that stops — and the state says so.
      const proceed = opts.onEscalation
        ? await opts.onEscalation({
            message: err.message,
            problems: err.report.problems,
            script: err.script,
            factCheck: err.report,
          })
        : false;

      if (!proceed) {
        await saveState(ws, { ...state, phase: "failed", blocked_on: err.message });
        throw new ResearchEscalation(err.message);
      }

      // Approved anyway. This is a human deciding to narrate a line no source
      // supports, which is a real decision they are allowed to make — but it is
      // recorded loudly here and shown again at Gate C, because the one thing
      // that must never happen is it being quietly forgotten.
      await emit(
        runId,
        "script",
        "log",
        `Gate A approved the ESCALATED script — ${err.report.problems.length} unsourced ` +
          `line(s) will be narrated with no source behind them:\n${err.report.problems.join("\n")}`,
      );
      state = await saveState(ws, { ...state, blocked_on: undefined });
      scripted = {
        script: err.script,
        factCheck: err.report,
        attempts: err.attempts,
        inputTokens: err.inputTokens,
        outputTokens: err.outputTokens,
      };
      unsourcedLines = err.report.problems;
    } else {
      throw err;
    }
  }

  state = await recordCost(ws, state, "script", {
    inputTokens: scripted.inputTokens,
    outputTokens: scripted.outputTokens,
    wallClockMs: 0,
  });
  const script = scripted.script;
  log(
    `script: ${script.beats.length} beats, fact-check passed on attempt ` +
      `${scripted.attempts}, ${script.claims.length} sourced claim(s)`,
  );
  for (const line of scripted.factCheck.lines) {
    log(`  [${line.status}] ${line.beat_id}: ${line.vo_text}`);
  }
  await writeFile(join(ws.root, "script.json"), JSON.stringify(script, null, 2));
  await writeFile(join(ws.root, "factcheck.json"), JSON.stringify(scripted.factCheck, null, 2));

  // ── TTS: audio-first, real measured durations (PRD §3.7) ───────────────────
  state = await setPhase(ws, state, "tts");
  const voiceover: VoiceoverClip[] = [];
  for (const beat of script.beats) {
    const clip = await synthesize({
      text: beat.vo_text,
      voice,
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
  log(
    `VO total: ${voTotal.toFixed(1)}s (target ${targetDurationS}s, window ${min}-${max}s)` +
      (durationWarning ? `\n  WARNING: ${durationWarning}` : ""),
  );
  if (durationWarning) await emit(runId, "tts", "log", durationWarning);

  // ── Asset manifest (PRD §3.8) ──────────────────────────────────────────────
  state = await setPhase(ws, state, "assets");
  const manifest = await acquireAssets(script, ws.root, { voiceover });
  for (const a of manifest.assets) {
    log(`  ${a.beat_id}: ${a.kind} ${a.width}x${a.height} (${a.license.provider})`);
  }
  state = await saveState(ws, { ...state, script, manifest });

  // The dashboard reads these out of GridFS, so they are uploaded before the
  // gate opens — a gate that points at artifacts nobody can fetch is useless.
  await putArtifact(runId, join(ws.root, "script.json"), { kind: "script", phase: "script" });
  await putArtifact(runId, join(ws.root, "brief.json"), { kind: "brief", phase: "research" });
  await putArtifact(runId, join(ws.root, "factcheck.json"), { kind: "factcheck", phase: "script" });
  for (const v of voiceover) {
    await putArtifact(runId, v.path, { kind: "voiceover", phase: "tts", label: v.beat_id });
  }

  // ── Gate A (PRD §3): a human approves the script before anything is cut. ───
  await openGate(runId, "A_script", {
    shortlist: shortlist.map((r) => ({
      title: r.story.title,
      url: r.story.url,
      score: r.score,
      justification: r.justification,
    })),
    brief,
    script,
    factCheck: scripted.factCheck,
    voiceover: voiceover.map((v) => ({ beat_id: v.beat_id, path: v.path, durationS: v.durationS })),
    assets: manifest.assets.map((a) => ({ beat_id: a.beat_id, kind: a.kind, path: a.path })),
    voTotalS: Number(voTotal.toFixed(2)),
    durationWarning,
  });

  return {
    state,
    script,
    manifest,
    brief,
    factCheck: scripted.factCheck,
    voiceover,
    story: pickedStory,
    shortlist,
    voTotalS: Number(voTotal.toFixed(2)),
    durationWarning,
    unsourcedLines,
  };
}
