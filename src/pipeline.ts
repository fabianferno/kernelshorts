import { executeRun, findResumableRun } from "./run/execute.js";
import { closeDb } from "./db/mongo.js";

/**
 * One-shot run, for when you want a run in the foreground and nothing else.
 *
 * The normal way to operate this project is `pnpm server` (a daemon that owns
 * runs, resumes interrupted ones on boot, and is driven from the dashboard).
 * This entrypoint stays because a foreground run is genuinely easier to watch
 * while working on the pipeline itself — but it is the same executeRun() the
 * server calls, not a second implementation that can drift from it.
 *
 * Run:
 *   npx tsx src/pipeline.ts [voiceName]
 *
 * There is no --resume flag any more. If a previous run was interrupted after
 * Gate A, this picks it up automatically, because a human retyping a command to
 * recover state the process can see for itself was never a decision worth
 * asking for.
 */

const args = process.argv.slice(2);
const voice = args.find((a) => !a.startsWith("--"));

try {
  const resumable = await findResumableRun();
  if (resumable) {
    console.log(
      `run ${resumable.run_id} was interrupted in phase "${resumable.phase}" and has ` +
        `an approved script — resuming it instead of starting a new one.\n`,
    );
  }

  // The resumed run keeps its OWN id and slug: an interrupted run is usually
  // yesterday's, and resuming it under today's date would look in an empty
  // workspace and report "nothing to resume".
  const result = await executeRun({
    voice,
    resume: Boolean(resumable),
    runId: resumable?.run_id,
    dateSlug: resumable?.date_slug,
    onProgress: (m) => console.log(m),
  });

  // A rejected gate and a failed phase are both non-zero: this is a CLI, and a
  // shell that cannot tell "made a video" from "a human said no" is useless in
  // anything that wraps it.
  if (result.status !== "delivered") process.exitCode = 1;
} finally {
  await closeDb();
}
