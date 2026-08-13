import type { PublishMetadata } from "@worker/publish/metadata";
import type { ArtifactRow, PublishRecord } from "@/lib/data";
import type { GatePayload } from "@/lib/gate-payload";
import { fmtBytes } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import { MarkPublished } from "@/components/MarkPublished";

/**
 * The delivery view: everything needed to actually post the video, on one
 * screen, in the order the job is done — watch it, get the file, paste the
 * copy, record that it went out.
 *
 * Publishing is manual (the YouTube/Instagram clients are deferred to the end
 * of the project), so this panel IS the publish step. It is built to be read
 * next to an upload form in another tab: every field the human retypes has a
 * copy button, and the character counts are the platforms' real limits so a
 * title is rejected here rather than by YouTube after a 44 MB upload.
 */

/** YouTube's `videos.insert` hard cap; also the max on PublishMetadata.title. */
const YOUTUBE_TITLE_MAX = 100;
/** Instagram's caption limit. Hashtags live inside the caption, so they count. */
const INSTAGRAM_CAPTION_MAX = 2200;

function Count({ n, max }: { n: number; max: number }) {
  const state = n > max ? "text-bad" : n > max * 0.9 ? "text-warn" : "text-dim";
  return (
    <span className={`tabular-nums ${state}`}>
      {n}/{max}
    </span>
  );
}

/** A block of copy with its own copy button. `mono` for anything the user is
 *  going to eyeball for stray characters (paths, hashtags). */
function CopyField({
  label,
  value,
  count,
  mono = false,
}: {
  label: string;
  value: string;
  count?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-dim">{label}</span>
        {count}
        <CopyButton text={value} className="ml-auto" />
      </div>
      {/* select-all: the fallback path when the clipboard API is unavailable is
          "click, ctrl-A, copy", and that has to be one click away. */}
      <div
        className={`select-all whitespace-pre-wrap break-words rounded border border-line bg-ink px-2 py-1.5 text-fg ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function DeliveryPanel({
  runId,
  artifact,
  payload,
  metadata,
  metadataSource,
  published,
  topic,
  fallbackPaths,
}: {
  runId: string;
  artifact: ArtifactRow | null;
  payload: GatePayload | null;
  metadata: PublishMetadata | null;
  metadataSource: string | null;
  published: PublishRecord | null;
  topic: { title: string; url: string; hn_id?: number } | null;
  fallbackPaths: string[];
}) {
  // The gate payload records the delivered copy in ~/pipeline/out; the run's
  // `exports` array holds every iteration's master in the run workspace. The
  // first is the file to upload, the second is only a fallback for runs
  // delivered before the out-dir existed.
  const localPath = payload?.outPath ?? fallbackPaths.at(-1) ?? null;
  const probe = payload?.probe;

  const hashtagLine = metadata ? metadata.hashtags.join(" ") : "";

  return (
    <div className="flex flex-col gap-3">
      {/* ── the file ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row">
        {artifact ? (
          <video
            controls
            preload="metadata"
            src={`/api/artifacts/${artifact.id}`}
            className="w-[220px] shrink-0 self-start rounded border border-line bg-ink"
          />
        ) : (
          <p className="text-dim italic">
            no export artifact in GridFS for this run — nothing to play from here
          </p>
        )}

        <div className="min-w-0 flex-1">
          <table className="w-full border-collapse">
            <tbody>
              <tr className="border-b border-line/50">
                <td className="py-1 pr-3 align-top text-dim">file</td>
                <td className="py-1 text-fg">
                  {payload?.filename ?? artifact?.filename ?? "—"}
                </td>
              </tr>
              <tr className="border-b border-line/50">
                <td className="py-1 pr-3 align-top text-dim">size</td>
                <td className="py-1 tabular-nums text-fg">
                  {artifact ? (
                    <>
                      {fmtBytes(artifact.sizeBytes)}{" "}
                      <span className="text-dim">({artifact.sizeBytes.toLocaleString()} bytes)</span>
                    </>
                  ) : probe ? (
                    fmtBytes(probe.sizeBytes)
                  ) : (
                    <span className="text-dim italic">not recorded</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-line/50">
                <td className="py-1 pr-3 align-top text-dim">duration</td>
                <td className="py-1 tabular-nums text-fg">
                  {probe ? (
                    <>
                      {probe.durationS.toFixed(1)}s
                      {payload?.durationNote ? (
                        <span className="ml-2 text-warn">{payload.durationNote}</span>
                      ) : null}
                    </>
                  ) : (
                    /* deliver() ffprobes the delivered copy and puts the result
                       on the gate. A run with no gate C was never probed — the
                       number is genuinely absent, not zero. */
                    <span className="text-dim italic">not probed — no gate C payload</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-line/50">
                <td className="py-1 pr-3 align-top text-dim">resolution</td>
                <td className="py-1 tabular-nums text-fg">
                  {probe ? (
                    `${probe.width}×${probe.height}`
                  ) : (
                    <span className="text-dim italic">not probed — no gate C payload</span>
                  )}
                </td>
              </tr>
              {payload?.meanScore !== undefined ? (
                <tr className="border-b border-line/50">
                  <td className="py-1 pr-3 align-top text-dim">review</td>
                  <td className="py-1 text-fg">
                    mean {payload.meanScore.toFixed(2)}{" "}
                    <span
                      className={payload.reviewStatus === "escalate" ? "text-warn" : "text-ok"}
                    >
                      {payload.reviewStatus}
                    </span>
                    {payload.reviewNotes ? (
                      <div className="text-warn">{payload.reviewNotes}</div>
                    ) : null}
                  </td>
                </tr>
              ) : null}
              {payload?.gateAComment ? (
                <tr className="border-b border-line/50">
                  <td className="py-1 pr-3 align-top text-dim">gate A note</td>
                  <td className="py-1 text-muted">{payload.gateAComment}</td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {artifact ? (
              <a
                href={`/api/artifacts/${artifact.id}?download=1`}
                className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-accent hover:bg-accent/20"
              >
                download mp4
              </a>
            ) : null}
            {localPath ? (
              <CopyButton text={localPath} label="copy local path" />
            ) : null}
          </div>

          {localPath ? (
            <div className="mt-2">
              <div className="text-[11px] uppercase tracking-wider text-dim">
                on the worker Mac — usually faster than downloading it
              </div>
              <div className="select-all break-all rounded border border-line bg-ink px-2 py-1 font-mono text-fg">
                {localPath}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── the copy ───────────────────────────────────────────────────── */}
      <div className="border-t border-line pt-3">
        {metadata ? (
          <>
            <div className="mb-2 text-dim">
              publish copy · read from {metadataSource}
            </div>
            <CopyField
              label="YouTube title"
              value={metadata.title}
              count={<Count n={metadata.title.length} max={YOUTUBE_TITLE_MAX} />}
            />
            <CopyField label="YouTube description" value={metadata.description} />
            <CopyField
              label="hashtags"
              value={hashtagLine}
              count={<span className="text-dim tabular-nums">{metadata.hashtags.length}</span>}
              mono
            />
            <CopyField
              label="Instagram caption"
              value={metadata.instagram_caption}
              count={
                <Count n={metadata.instagram_caption.length} max={INSTAGRAM_CAPTION_MAX} />
              }
            />
          </>
        ) : (
          <p className="text-dim italic">
            no publish copy for this run — neither the C_publish gate payload nor a
            metadata artifact holds a valid PublishMetadata. deliver() writes both;
            a run that never reached the export phase has neither.
          </p>
        )}
      </div>

      {/* ── the record ─────────────────────────────────────────────────── */}
      <div className="border-t border-line pt-3">
        {topic ? (
          <MarkPublished
            runId={runId}
            topicUrl={topic.url}
            topicTitle={topic.title}
            hnId={topic.hn_id}
            published={published}
          />
        ) : (
          <p className="text-dim italic">
            no topic on this run — publishing cannot be recorded without the url the
            HN dedupe matches on
          </p>
        )}
      </div>
    </div>
  );
}
