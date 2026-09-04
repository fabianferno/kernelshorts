import { join } from "node:path";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateMetadata, type PublishMetadata } from "../publish/metadata.js";
import { openGate } from "../run/gates.js";
import { putArtifact } from "../run/artifacts.js";
import { emit, type Workspace } from "../run/workspace.js";
import { notify } from "../notify/push.js";
import { config } from "../config.js";
import type { ScriptJSON } from "../shared/schemas.js";

const exec = promisify(execFile);

/**
 * Delivery: turning a finished render into something a person can pick up.
 *
 * Automated publishing is deferred to the end of the project, so this is where
 * an automated run stops. That makes the hand-off the product, not a formality:
 * the video lands in ONE predictable folder with a name that says what it is,
 * and the copy to paste alongside it is generated and shown at Gate C.
 *
 * The run workspace is not that folder. `~/pipeline/runs/<date>/exports/`
 * holds every iteration's master plus the raw pre-normalisation exports, and
 * asking someone to pick the right file out of that most days is how the wrong
 * video gets posted.
 */

/** One flat folder of finished videos, newest name sorting last. */
export const OUT_DIR = join(process.env.HOME ?? "~", "pipeline", "out");

export interface DeliverOptions {
  runId: string;
  ws: Workspace;
  script: ScriptJSON;
  /** The loudness-normalised master the review loop finished on. */
  masterPath: string;
  reviewStatus: "passed" | "escalate";
  reviewNotes?: string;
  gateAComment?: string;
  /**
   * Lines the fact-checker rejected that a human approved anyway at an
   * escalated Gate A. Surfaced at Gate C so nobody publishes a video
   * containing an unsupported claim without being told, twice.
   */
  unsourcedLines?: string[];
  meanScore: number;
  hnId?: number;
  topicUrl: string;
  onProgress?: (message: string) => void;
}

export interface DeliverResult {
  outPath: string;
  outDir: string;
  metadata: PublishMetadata;
  probe: { durationS: number; width: number; height: number; sizeBytes: number };
}

/** Filesystem-safe slug of the topic, capped so the filename stays readable. */
export function topicSlug(title: string, maxLength = 60): string {
  const slug = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length <= maxLength) return slug;
  // Cut at a word boundary — a filename ending mid-word reads like corruption.
  return slug.slice(0, maxLength).replace(/-[^-]*$/, "");
}

export async function deliver(opts: DeliverOptions): Promise<DeliverResult> {
  const { runId, ws, script, masterPath, topicUrl, hnId } = opts;
  const log = opts.onProgress ?? (() => {});

  await mkdir(OUT_DIR, { recursive: true });
  const name = `${ws.dateSlug}-${topicSlug(script.topic.title)}.mp4`;
  const outPath = join(OUT_DIR, name);
  await copyFile(masterPath, outPath);

  // Re-probe the COPY, not the source. A truncated copy is exactly the failure
  // this catches, and probing the original would report the original's health.
  const probe = await probeVideo(outPath);
  log(`delivered ${name} — ${probe.width}x${probe.height}, ${probe.durationS.toFixed(1)}s`);

  const { width, height } = config.video;
  if (probe.width !== width || probe.height !== height) {
    throw new Error(
      `Delivered file is ${probe.width}x${probe.height}, not ${width}x${height}. ` +
        `Something upstream changed the canvas and this is not publishable as a short.`,
    );
  }
  const { min, max } = config.video.targetDurationS;
  const durationNote =
    probe.durationS < min || probe.durationS > max
      ? `Runs ${probe.durationS.toFixed(1)}s, outside the ${min}-${max}s format window.`
      : undefined;

  // ── Publish copy, generated once and stored with the run. ─────────────────
  const meta = await generateMetadata({ script });
  const metadataPath = join(ws.root, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(meta.metadata, null, 2));
  log(`metadata: "${meta.metadata.title}" (${meta.metadata.title.length}/100 chars)`);

  // Both go to GridFS so the dashboard can play the video and show the copy
  // without reaching into the worker's filesystem.
  const artifact = await putArtifact(runId, outPath, {
    kind: "export",
    phase: "export",
    label: `final master — mean ${opts.meanScore.toFixed(2)}`,
  });
  await putArtifact(runId, metadataPath, { kind: "metadata", phase: "export" });

  await emit(runId, "export", "artifact", `delivered ${name}`, {
    outPath,
    sizeBytes: probe.sizeBytes,
    durationS: probe.durationS,
  });

  // ── Gate C: publish approval (PRD §6), which a human performs by hand. ────
  await openGate(runId, "C_publish", {
    outPath,
    outDir: OUT_DIR,
    filename: name,
    artifactId: String(artifact._id ?? ""),
    metadata: meta.metadata,
    probe,
    durationNote,
    reviewStatus: opts.reviewStatus,
    reviewNotes: opts.reviewNotes,
    meanScore: opts.meanScore,
    // Shown again here so the person publishing can see whether the note they
    // left at Gate A was actually addressed by the edit.
    gateAComment: opts.gateAComment,
    unsourcedLines: opts.unsourcedLines,
    topic: { title: script.topic.title, url: topicUrl, hn_id: hnId },
  });

  await notify({
    title: `Ready to publish: ${script.topic.title}`,
    body: `${probe.durationS.toFixed(0)}s · rubric ${opts.meanScore.toFixed(2)} · ${name}`,
    url: config.dashboardUrl ? `${config.dashboardUrl}/runs/${runId}` : undefined,
  });

  return { outPath, outDir: OUT_DIR, metadata: meta.metadata, probe };
}

async function probeVideo(path: string): Promise<DeliverResult["probe"]> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`Delivered file has no video stream: ${path}`);
  return {
    durationS: Number(parsed.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    sizeBytes: Number(parsed.format?.size ?? 0),
  };
}
