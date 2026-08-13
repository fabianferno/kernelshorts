import { NextResponse } from "next/server";
import { z } from "zod";
import { markPublished } from "@worker/publish/record";
import { resolveGate, getGate } from "@worker/run/gates";

export const dynamic = "force-dynamic";

/**
 * "I posted it." The one write behind the manual publish hand-off.
 *
 * Two things have to happen and they are not equally recoverable:
 *
 *  1. `published_topics` gets a row, or tomorrow's HN ingest picks the same
 *     story again and nobody notices until a duplicate video exists.
 *  2. Gate C closes, so the run stops showing as blocked.
 *
 * So (1) runs first. If the gate close then fails, the worst case is a run that
 * still reads "awaiting publish" — visible, and fixable with one more click.
 * The reverse order would close the gate and lose the dedupe row silently.
 *
 * `markPublished` is imported, never reimplemented: the dedupe matches on
 * `normalizeUrl(url)` computed at write time by `recordPublishedTopic`, and a
 * second normalizer here would have to agree with it byte for byte forever.
 */
const Body = z.object({
  run_id: z.string().min(1),
  /** The article URL — the value `dedupeAgainstPublished` matches on. Not the
   *  YouTube URL: the dedupe is about the STORY, not our post. */
  url: z.string().url(),
  title: z.string().trim().min(1),
  /** What the human actually posted to. Ticking both when only one went out
   *  would record a publish that never happened, so the UI never pre-fills. */
  platforms: z.array(z.enum(["youtube_shorts", "instagram_reels"])).min(1),
  hn_id: z.number().int().optional(),
  /** Free text — in practice the live post URL. */
  notes: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { run_id, url, title, platforms, hn_id, notes } = parsed.data;

  let result;
  try {
    result = await markPublished({ runId: run_id, url, title, platforms, hnId: hn_id, notes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Recording the publish failed: ${message}` }, { status: 500 });
  }

  // The gate is best-effort by design (see above). A run delivered before Gate C
  // existed, or one whose gate was already superseded, still gets its topic
  // recorded — that is the part that cannot be repaired later.
  let gate: string;
  try {
    const existing = await getGate(run_id, "C_publish");
    if (!existing) {
      gate = "no C_publish gate on this run — nothing to close";
    } else if (existing.status !== "open") {
      gate = `already ${existing.status}`;
    } else {
      await resolveGate(
        run_id,
        "C_publish",
        "approved",
        `published to ${platforms.join(", ")}${notes ? ` — ${notes}` : ""}`,
      );
      gate = "approved";
    }
  } catch (error) {
    gate = `NOT closed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return NextResponse.json({ published: { ...result, platforms }, gate });
}
