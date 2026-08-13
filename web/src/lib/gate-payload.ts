import { z } from "zod";
import { ScriptJSON } from "@worker/shared/schemas";
import { ResearchBrief } from "@worker/research/brief";
import { FactCheckReport } from "@worker/research/factcheck";
import { PublishMetadata } from "@worker/publish/metadata";

/**
 * `Approval.payload` is `z.unknown()` in gates.ts on purpose — each gate carries
 * a different bundle. This narrows the shapes the dashboard renders, reusing the
 * worker's own schemas for the three big ones so a change to the brief or the
 * fact-check report is a type error here rather than a blank panel.
 *
 * Every field is optional because Gate A has two forms: the normal one that
 * m3.ts opens after a passing fact-check, and the `outcome: "escalated"` one it
 * opens when the script could not be sourced after two rewrites — that one has
 * no brief and no shortlist. Rendering "not recorded" for a missing section is
 * correct; inventing one is not.
 */
export const GatePayload = z
  .object({
    outcome: z.string().optional(),
    reason: z.string().optional(),
    problems: z.array(z.string()).optional(),
    shortlist: z
      .array(
        z.object({
          title: z.string(),
          url: z.string().nullable().optional(),
          score: z.number(),
          justification: z.string(),
        }),
      )
      .optional(),
    brief: ResearchBrief.optional(),
    script: ScriptJSON.optional(),
    factCheck: FactCheckReport.optional(),
    voiceover: z
      .array(z.object({ beat_id: z.string(), path: z.string(), durationS: z.number() }))
      .optional(),
    assets: z
      .array(z.object({ beat_id: z.string(), kind: z.string(), path: z.string() }))
      .optional(),
    voTotalS: z.number().optional(),
    durationWarning: z.string().nullable().optional(),

    /* ── Gate C (deliver.ts) ────────────────────────────────────────────────
     * The publish gate carries the whole hand-off: where the file is on the
     * worker's disk, the real ffprobe measurements of the DELIVERED copy, and
     * the copy to paste. `metadata` reuses the worker's PublishMetadata rather
     * than a local shape — the 100-char title cap the UI counts against is the
     * schema's cap, and two copies of it would eventually disagree about what
     * YouTube accepts. */
    outPath: z.string().optional(),
    outDir: z.string().optional(),
    filename: z.string().optional(),
    artifactId: z.string().optional(),
    metadata: PublishMetadata.optional(),
    probe: z
      .object({
        durationS: z.number(),
        width: z.number(),
        height: z.number(),
        sizeBytes: z.number(),
      })
      .optional(),
    durationNote: z.string().nullable().optional(),
    reviewStatus: z.string().optional(),
    reviewNotes: z.string().optional(),
    meanScore: z.number().optional(),
    gateAComment: z.string().optional(),
    topic: z
      .object({
        title: z.string(),
        url: z.string(),
        hn_id: z.number().nullable().optional(),
      })
      .optional(),
  })
  /** Gate B/C will carry keys this schema has never seen; passing them through
   *  is better than stripping data the operator might need at 2am. */
  .passthrough();

export type GatePayload = z.infer<typeof GatePayload>;

/** Never throws: a payload we cannot narrow still has to be shown as raw JSON
 *  rather than crashing the approval inbox the run is blocked on. */
export function parseGatePayload(payload: unknown): GatePayload | null {
  const parsed = GatePayload.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
