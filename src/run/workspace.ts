import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { db, COLLECTIONS } from "../db/mongo.js";
import { RunState, RunEvent, type RunPhase } from "../shared/schemas.js";

/**
 * Run workspace (PRD §2):
 *   ~/pipeline/runs/<date-slug>/{assets,vo,exports,checkpoints,state.json}
 *
 * The filesystem holds the heavy artifacts; MongoDB holds the run record and
 * event stream that the web app reads. Both are written on every transition so
 * a crashed run is inspectable rather than silently lost.
 */

export interface Workspace {
  runId: string;
  dateSlug: string;
  root: string;
  assets: string;
  vo: string;
  exports: string;
  checkpoints: string;
  statePath: string;
}

export function dateSlug(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function createWorkspace(runId: string, slug = dateSlug()): Promise<Workspace> {
  const root = join(config.paths.runsRoot, slug);
  const ws: Workspace = {
    runId,
    dateSlug: slug,
    root,
    assets: join(root, "assets"),
    vo: join(root, "vo"),
    exports: join(root, "exports"),
    checkpoints: join(root, "checkpoints"),
    statePath: join(root, "state.json"),
  };
  for (const dir of [ws.assets, ws.vo, ws.exports, ws.checkpoints]) {
    await mkdir(dir, { recursive: true });
  }
  return ws;
}

export async function initState(ws: Workspace): Promise<RunState> {
  const now = new Date().toISOString();
  const state = RunState.parse({
    run_id: ws.runId,
    date_slug: ws.dateSlug,
    phase: "research" satisfies RunPhase,
    workspace: ws.root,
    iterations: 0,
    exports: [],
    telemetry: [],
    created_at: now,
    updated_at: now,
  });
  await saveState(ws, state);
  return state;
}

export async function loadState(ws: Workspace): Promise<RunState | undefined> {
  if (!existsSync(ws.statePath)) return undefined;
  return RunState.parse(JSON.parse(await readFile(ws.statePath, "utf8")));
}

/** Writes state to disk AND upserts the run record for the dashboard. */
export async function saveState(ws: Workspace, state: RunState): Promise<RunState> {
  const next = RunState.parse({ ...state, updated_at: new Date().toISOString() });
  await writeFile(ws.statePath, JSON.stringify(next, null, 2));
  const runs = (await db()).collection<RunState>(COLLECTIONS.runs);
  await runs.createIndex({ run_id: 1 }, { unique: true });
  await runs.replaceOne({ run_id: next.run_id }, next, { upsert: true });
  return next;
}

export async function setPhase(
  ws: Workspace,
  state: RunState,
  phase: RunPhase,
): Promise<RunState> {
  const next = await saveState(ws, { ...state, phase });
  await emit(ws.runId, phase, "log", `phase → ${phase}`);
  return next;
}

/** Appends to the live event feed the dashboard renders (PRD §2). */
export async function emit(
  runId: string,
  phase: RunPhase,
  kind: RunEvent["kind"],
  message: string,
  data?: unknown,
): Promise<void> {
  const event = RunEvent.parse({
    run_id: runId,
    ts: new Date().toISOString(),
    phase,
    kind,
    message,
    data,
  });
  await (await db()).collection<RunEvent>(COLLECTIONS.runEvents).insertOne(event);
  const tag = kind === "error" ? "ERROR" : kind;
  console.log(`[${event.ts}] ${phase}/${tag}: ${message}`);
}

/**
 * Records tokens + wall clock per phase (PRD §8: cost telemetry from day 1;
 * the vision review loop is the expected cost centre).
 */
export async function recordCost(
  ws: Workspace,
  state: RunState,
  phase: RunPhase,
  cost: { inputTokens: number; outputTokens: number; wallClockMs: number },
): Promise<RunState> {
  return saveState(ws, { ...state, telemetry: [...state.telemetry, { phase, ...cost }] });
}

/** Times an async phase and records its cost in one step. */
export async function timed<T>(
  ws: Workspace,
  state: RunState,
  phase: RunPhase,
  fn: () => Promise<{ value: T; inputTokens?: number; outputTokens?: number }>,
): Promise<{ value: T; state: RunState }> {
  const started = Date.now();
  const { value, inputTokens = 0, outputTokens = 0 } = await fn();
  const next = await recordCost(ws, state, phase, {
    inputTokens,
    outputTokens,
    wallClockMs: Date.now() - started,
  });
  return { value, state: next };
}
