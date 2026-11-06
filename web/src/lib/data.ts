import "server-only";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { db, COLLECTIONS } from "@worker/db/mongo";
import { RunState, RunEvent, type RunPhase } from "@worker/shared/schemas";
import { Approval } from "@worker/run/gates";
import { listArtifacts, getArtifactStream } from "@worker/run/artifacts";

/**
 * Every read in this app goes through here, and every read parses with the
 * worker's own zod schemas (PRD §2: "everything that crosses a phase boundary
 * is schema-validated"). The dashboard is a consumer of that contract, so a
 * run the worker wrote in a shape the schema no longer describes should surface
 * as a loud failure here rather than a half-rendered page.
 */

/**
 * The Node driver persists an absent optional field as `null`, not by omitting
 * it — `RunState.blocked_on` round-trips as `blocked_on: null`, which
 * `z.string().optional()` rejects. Undo that at the boundary. Only top-level
 * keys: nested `payload` blobs are `z.unknown()` and their nulls are real data
 * (e.g. `durationWarning: null` means "measured, no warning").
 */
function undoDriverNulls<T extends Record<string, unknown>>(doc: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (v !== null) out[k] = v;
  return out as T;
}

/** ObjectId and Date instances cannot cross the server/client boundary. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface RunSummary {
  run_id: string;
  date_slug: string;
  phase: RunPhase;
  topic_title: string | null;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  exports: number;
  blocked_on: string | null;
  openGates: string[];
  updated_at: string;
}

export async function listRuns(): Promise<RunSummary[]> {
  const d = await db();
  const docs = await d
    .collection(COLLECTIONS.runs)
    .find({}, { projection: { _id: 0 } })
    .sort({ date_slug: -1, created_at: -1 })
    .toArray();

  const runs = docs.map((doc) => RunState.parse(undoDriverNulls(doc)));

  // One query for every run's open gates rather than N — the badge is on every
  // row and this list is the page people leave open all day.
  const open = await d
    .collection(COLLECTIONS.approvals)
    .find({ status: "open" }, { projection: { _id: 0, run_id: 1, gate: 1 } })
    .toArray();
  const gatesByRun = new Map<string, string[]>();
  for (const g of open) {
    const list = gatesByRun.get(g.run_id as string) ?? [];
    list.push(g.gate as string);
    gatesByRun.set(g.run_id as string, list);
  }

  return runs.map((r) => ({
    run_id: r.run_id,
    date_slug: r.date_slug,
    phase: r.phase,
    topic_title: r.script?.topic.title ?? null,
    iterations: r.iterations,
    inputTokens: r.telemetry.reduce((a, t) => a + t.inputTokens, 0),
    outputTokens: r.telemetry.reduce((a, t) => a + t.outputTokens, 0),
    wallClockMs: r.telemetry.reduce((a, t) => a + t.wallClockMs, 0),
    exports: r.exports.length,
    blocked_on: r.blocked_on ?? null,
    openGates: gatesByRun.get(r.run_id) ?? [],
    updated_at: r.updated_at,
  }));
}

export async function getRun(runId: string): Promise<RunState | null> {
  const doc = await (await db())
    .collection(COLLECTIONS.runs)
    .findOne({ run_id: runId }, { projection: { _id: 0 } });
  return doc ? plain(RunState.parse(undoDriverNulls(doc))) : null;
}

/**
 * `since` is an ISO timestamp, exclusive. The live feed polls with the ts of
 * the last event it holds, so a reconnect resumes exactly where it stopped
 * instead of re-rendering the whole run.
 */
export async function listEvents(runId: string, since?: string): Promise<RunEvent[]> {
  const query: Record<string, unknown> = { run_id: runId };
  if (since) query.ts = { $gt: since };
  const docs = await (await db())
    .collection(COLLECTIONS.runEvents)
    .find(query, { projection: { _id: 0 } })
    .sort({ ts: 1 })
    .toArray();
  return docs.map((doc) => plain(RunEvent.parse(undoDriverNulls(doc))));
}

export interface ArtifactRow {
  id: string;
  filename: string;
  kind: string;
  phase: string | null;
  label: string | null;
  contentType: string;
  sizeBytes: number;
  source_path: string;
  created_at: string;
}

/**
 * Artifacts are the only run data this app does NOT read straight from a
 * collection: `listArtifacts` owns the index creation and the GridFS pairing,
 * and a second reader guessing at that shape is how the two drift.
 */
export async function listRunArtifacts(runId: string): Promise<ArtifactRow[]> {
  const docs = await listArtifacts(runId);
  return docs.map((a) => ({
    // Rows read back from Mongo always carry _id; gridfs_id exists only on legacy rows.
    id: (a._id ?? a.gridfs_id)!.toHexString(),
    filename: a.filename,
    kind: a.kind,
    phase: a.phase ?? null,
    label: a.label ?? null,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    source_path: a.source_path,
    created_at: a.created_at,
  }));
}

/**
 * Reads a JSON artifact out of GridFS. Used for the per-iteration rubric
 * scores, which the review loop writes as files rather than onto the run
 * record — a 4-iteration rubric with justifications is larger than the run
 * document has any business carrying.
 *
 * Returns null on a malformed blob instead of throwing: one unparseable rubric
 * must not take down the run page that shows why the run is stuck.
 */
export async function readJsonArtifact(id: string): Promise<unknown | null> {
  try {
    const { stream } = await getArtifactStream(id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The artifact row behind a single id, for the download route.
 *
 * `getArtifactStream` deliberately returns only the bytes and their framing —
 * it has no metadata-only lookup — so the one thing the download path needs
 * (which run this blob belongs to, so the filename can carry the topic) is not
 * reachable through it. This repeats `getArtifactStream`'s `_id ?? gridfs_id`
 * fallback because both ids appear in URLs: the artifacts table links by `_id`
 * while older event lines reference the GridFS id.
 */
export async function getArtifactMeta(
  id: string,
): Promise<{ run_id: string; filename: string; contentType: string } | null> {
  if (!ObjectId.isValid(id)) return null;
  const _id = new ObjectId(id);
  const col = (await db()).collection(COLLECTIONS.artifacts);
  const doc = (await col.findOne({ _id })) ?? (await col.findOne({ gridfs_id: _id }));
  if (!doc) return null;
  return {
    run_id: doc.run_id as string,
    filename: doc.filename as string,
    contentType: doc.contentType as string,
  };
}

/**
 * The name the browser should save an artifact as.
 *
 * The stored filename is the worker's internal one (`m1-2026-08-12-v2-master.mp4`),
 * which says nothing about the video once it is sitting in ~/Downloads next to
 * thirty other files. `<date>-<topic-slug>.<ext>` is what the human is actually
 * looking for. Built entirely server-side from the run record: a filename taken
 * from a query param would be a header-injection hole in Content-Disposition.
 */
export async function artifactDownloadName(id: string): Promise<string | null> {
  const meta = await getArtifactMeta(id);
  if (!meta) return null;
  const run = await getRun(meta.run_id);
  const ext = meta.filename.includes(".") ? meta.filename.slice(meta.filename.lastIndexOf(".")) : "";
  const slug = slugify(run?.script?.topic.title ?? "");
  if (!run || !slug) return meta.filename; // no script yet — the raw name is the honest answer
  return `${run.date_slug}-${slug}${ext}`;
}

/** Lowercase ASCII words joined by dashes, capped so the result stays a
 *  filename and not a sentence. Non-ASCII titles collapse to "" and the caller
 *  falls back to the stored filename rather than emitting `--.mp4`. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
}

export async function listApprovals(runId?: string): Promise<Approval[]> {
  const query = runId ? { run_id: runId } : {};
  const docs = await (await db())
    .collection(COLLECTIONS.approvals)
    .find(query, { projection: { _id: 0 } })
    .sort({ opened_at: -1 })
    .toArray();
  return docs.map((doc) => plain(Approval.parse(undoDriverNulls(doc))));
}

export async function listOpenApprovals(): Promise<Approval[]> {
  const docs = await (await db())
    .collection(COLLECTIONS.approvals)
    .find({ status: "open" }, { projection: { _id: 0 } })
    .sort({ opened_at: -1 })
    .toArray();
  return docs.map((doc) => plain(Approval.parse(undoDriverNulls(doc))));
}
