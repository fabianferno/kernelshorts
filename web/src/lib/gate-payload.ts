import { z } from "zod";
import { ScriptJSON } from "@worker/shared/schemas";

/**
 * `Approval.payload` is `z.unknown()` in gates.ts on purpose — each gate carries
 * a different bundle. This narrows the shapes the dashboard knows how to render;
 * every field is optional and unknown keys pass through.
 */
export const GatePayload = z
  .object({
    outcome: z.string().optional(),
    reason: z.string().optional(),
    problems: z.array(z.string()).optional(),
    script: ScriptJSON.optional(),
    voiceover: z
      .array(z.object({ beat_id: z.string(), path: z.string(), durationS: z.number() }))
      .optional(),
    assets: z
      .array(z.object({ beat_id: z.string(), kind: z.string(), path: z.string() }))
      .optional(),
    voTotalS: z.number().optional(),
    durationWarning: z.string().nullable().optional(),
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
