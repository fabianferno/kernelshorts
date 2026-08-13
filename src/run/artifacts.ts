import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { db, COLLECTIONS } from "../db/mongo.js";

/**
 * Artifact storage (PRD §2: the control plane's `artifacts` table + artifact
 * viewer).
 *
 * GridFS rather than Supabase Storage because the run record already lives in
 * this Atlas cluster and a second credential for a second blob store buys
 * nothing: the only readers are the web app and this worker. A finished short
 * is ~44 MB, which is 176 default-size (256 KiB) GridFS chunks — measured
 * upload of a real 44,197,148-byte master took 25.8 s over the home link to
 * Atlas, i.e. we are bandwidth-bound, not chunking-bound.
 *
 * Everything here streams. Buffering a 44 MB mp4 to hand Mongo a Buffer works
 * right up until two runs overlap, and the range read exists specifically so a
 * <video> element can seek without pulling the whole file.
 */

/** Sniffed from the extension. The web app sets Content-Type from this, and a
 *  wrong value on the mp4 is the difference between a playing <video> and a
 *  download prompt, so the video/audio cases are the ones that matter. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".srt": "application/x-subrip",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type ArtifactKind =
  | "export"
  | "voiceover"
  | "asset"
  | "script"
  | "brief"
  | "factcheck"
  | "rubric"
  /** Publish copy (title/description/hashtags) for the manual publish step. */
  | "metadata"
  | "frame"
  | "checkpoint"
  | "state";

export interface ArtifactMeta {
  kind: ArtifactKind;
  /** Which pipeline phase produced it; free-form so RunPhase can grow. */
  phase?: string;
  /** Human label for the artifact viewer, e.g. "iteration 2 export". */
  label?: string;
}

export interface ArtifactDoc {
  _id?: ObjectId;
  run_id: string;
  gridfs_id: ObjectId;
  /** Source basename, not the full path — the path is a worker-local detail. */
  filename: string;
  /** The absolute local path, kept as the dedupe key for re-uploads. */
  source_path: string;
  contentType: string;
  sizeBytes: number;
  kind: ArtifactKind;
  phase?: string;
  label?: string;
  created_at: string;
}

const BUCKET = "artifacts";

async function bucket(database: Db): Promise<GridFSBucket> {
  return new GridFSBucket(database, { bucketName: BUCKET });
}

async function collection() {
  const database = await db();
  const col = database.collection<ArtifactDoc>(COLLECTIONS.artifacts);
  await col.createIndex({ run_id: 1, source_path: 1 }, { unique: true });
  await col.createIndex({ created_at: 1 });
  return { database, col };
}

/**
 * Streams a real local file into GridFS and records it.
 *
 * Re-uploading the same path for the same run REPLACES the previous blob. The
 * review loop exports to the same filename on every iteration, so without this
 * a 4-iteration run would leave 3 orphaned 44 MB blobs in the cluster.
 */
export async function putArtifact(
  runId: string,
  localPath: string,
  meta: ArtifactMeta,
): Promise<ArtifactDoc> {
  const info = await stat(localPath); // throws if the file is not real — intended
  if (!info.isFile()) throw new Error(`Not a file: ${localPath}`);

  const { database, col } = await collection();
  const gfs = await bucket(database);
  const contentType = contentTypeFor(localPath);
  const filename = basename(localPath);

  const upload = gfs.openUploadStream(filename, {
    contentType,
    metadata: { run_id: runId, kind: meta.kind, phase: meta.phase, label: meta.label },
  });
  await pipeline(createReadStream(localPath), upload);

  const doc: ArtifactDoc = {
    run_id: runId,
    gridfs_id: upload.id,
    filename,
    source_path: localPath,
    contentType,
    sizeBytes: info.size,
    kind: meta.kind,
    phase: meta.phase,
    label: meta.label,
    created_at: new Date().toISOString(),
  };

  // Read the previous row first and take the replacement back "after": the
  // caller needs the stable _id (the web app's artifact URL), and on a replace
  // Mongo keeps the original _id, so the returned doc is the one to hand back.
  const previous = await col.findOne({ run_id: runId, source_path: localPath });
  const stored = await col.findOneAndReplace(
    { run_id: runId, source_path: localPath },
    doc,
    { upsert: true, returnDocument: "after" },
  );
  // Delete the superseded blob only after the new record is committed: an
  // artifact row pointing at a missing blob is worse than a leaked blob.
  if (previous?.gridfs_id) {
    await gfs.delete(previous.gridfs_id).catch(() => {
      // Already gone (a concurrent re-upload). Not worth failing the upload.
    });
  }
  return stored ?? doc;
}

export interface ArtifactStream {
  stream: NodeJS.ReadableStream;
  contentType: string;
  /** Full size of the artifact, not the length of this response. */
  sizeBytes: number;
  /** Byte offsets actually served, inclusive — what a 206 Content-Range needs. */
  start: number;
  end: number;
}

/**
 * Resolves an HTTP Range against a known size.
 *
 * Kept pure and separate because the off-by-ones here are the whole bug
 * surface: Range is INCLUSIVE at both ends, GridFS `end` is EXCLUSIVE, and a
 * browser's first probe on a <video> is `bytes=0-` which must not be read as
 * "zero bytes".
 */
export function resolveRange(
  sizeBytes: number,
  range?: { start?: number; end?: number },
): { start: number; end: number; length: number } {
  const start = Math.max(0, Math.floor(range?.start ?? 0));
  if (start >= sizeBytes && sizeBytes > 0) {
    throw new RangeError(`Range start ${start} is past end of ${sizeBytes}-byte artifact`);
  }
  const requestedEnd = range?.end === undefined ? sizeBytes - 1 : Math.floor(range.end);
  const end = Math.min(requestedEnd, sizeBytes - 1);
  if (end < start) {
    throw new RangeError(`Invalid range ${start}-${end} for ${sizeBytes}-byte artifact`);
  }
  return { start, end, length: end - start + 1 };
}

export async function getArtifactStream(
  id: string | ObjectId,
  range?: { start?: number; end?: number },
): Promise<ArtifactStream> {
  const { database, col } = await collection();
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const doc =
    (await col.findOne({ _id })) ?? (await col.findOne({ gridfs_id: _id }));
  if (!doc) throw new Error(`No artifact ${_id.toHexString()}`);

  const { start, end } = resolveRange(doc.sizeBytes, range);
  const gfs = await bucket(database);
  // +1: GridFS end is exclusive, HTTP Range end is inclusive.
  const stream = gfs.openDownloadStream(doc.gridfs_id, { start, end: end + 1 });
  return { stream, contentType: doc.contentType, sizeBytes: doc.sizeBytes, start, end };
}

export async function listArtifacts(runId: string): Promise<ArtifactDoc[]> {
  const { col } = await collection();
  return col.find({ run_id: runId }).sort({ created_at: 1 }).toArray();
}

/**
 * Retention (PRD §2 / M6): drops artifacts older than `days`, blob first-class.
 * Real deletion — there is no soft-delete flag to forget to sweep later.
 */
export async function deleteArtifactsOlderThan(days: number): Promise<number> {
  const { database, col } = await collection();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const gfs = await bucket(database);
  const stale = await col.find({ created_at: { $lt: cutoff } }).toArray();
  for (const doc of stale) {
    await gfs.delete(doc.gridfs_id).catch(() => {
      // Blob already missing; still remove the row so it stops being listed.
    });
    await col.deleteOne({ _id: doc._id });
  }
  return stale.length;
}
