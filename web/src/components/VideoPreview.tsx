import type { ArtifactRow } from "@/lib/data";
import { fmtBytes } from "@/lib/format";

/**
 * Plays the run's export straight out of GridFS.
 *
 * The `exports` array on the run record holds worker-local paths
 * (`~/pipeline/runs/<date>/exports/*.mp4`) which this app cannot open — a
 * hosted control plane has no access to the Mac's disk. Only an export that
 * `putArtifact` has uploaded is playable, so the two are shown separately: a
 * path with no artifact behind it is reported as not uploaded rather than
 * rendered as a broken player.
 */
export function VideoPreview({
  exportArtifacts,
  exportPaths,
}: {
  exportArtifacts: ArtifactRow[];
  exportPaths: string[];
}) {
  const uploaded = new Set(exportArtifacts.map((a) => a.source_path));
  const missing = exportPaths.filter((p) => !uploaded.has(p));

  return (
    <div>
      {exportArtifacts.length === 0 ? (
        <p className="text-dim italic">
          no export artifact in GridFS for this run — nothing to play
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {exportArtifacts.map((artifact) => (
            <figure key={artifact.id} className="w-[240px]">
              {/* preload="metadata" so the poster frame and duration appear
                  without pulling ~44 MB per export on page load; the range
                  route then serves only what scrubbing asks for. */}
              <video
                controls
                preload="metadata"
                src={`/api/artifacts/${artifact.id}`}
                className="w-full rounded border border-line bg-ink"
              />
              <figcaption className="mt-1 text-dim">
                <div className="truncate text-fg" title={artifact.filename}>
                  {artifact.label ?? artifact.filename}
                </div>
                {fmtBytes(artifact.sizeBytes)} · {artifact.contentType}
                <a
                  href={`/api/artifacts/${artifact.id}`}
                  className="ml-2 text-accent hover:underline"
                >
                  open
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {missing.length > 0 ? (
        <div className="mt-2 rounded border border-warn/40 bg-warn/5 p-2 text-warn">
          {missing.length} export(s) exist only on the worker&apos;s disk and were never
          uploaded — not playable from here:
          <ul className="mt-1 text-muted">
            {missing.map((p) => (
              <li key={p} className="truncate">
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
