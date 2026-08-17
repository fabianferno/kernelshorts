import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { executeRun, findResumableRun, DEFAULT_VOICE, type ExecuteRunResult } from "./run/execute.js";
import { closeDb } from "./db/mongo.js";
import { config } from "./config.js";

/**
 * The backend, as one long-running process.
 *
 * There used to be three commands — start a run, resume a crashed one, answer a
 * gate — and that was a symptom, not a design: the pipeline was a script that
 * exited, so every recovery path had to be re-entered by a human typing
 * something. A process that stays up absorbs all three:
 *
 *  - it resumes an interrupted run on boot, so `--resume` is not a command
 *  - it parks at a gate instead of blocking a terminal, so the dashboard is the
 *    only place a gate is answered and `gate.ts` is not part of normal use
 *  - it starts runs on request, so the dashboard has a button
 *
 * Deliberately dependency-free (node:http, no framework). The surface is four
 * endpoints on localhost; adding Express to serve four routes would be more
 * moving parts than the thing they do.
 *
 * NOT a scheduler. Nothing here starts a run on a clock — daily cadence is M6,
 * and inventing it early would mean a machine picking topics before the
 * watchdog and retention rules that are supposed to bound it exist.
 */

/**
 * One run at a time, enforced by this variable.
 *
 * Not a nicety: a run drives a single Palmier Pro instance over MCP and writes
 * to a date-keyed workspace. Two concurrent runs would fight over both, and the
 * failure would look like corrupted output rather than a clean error.
 */
let active: { runId: string; startedAt: string; promise: Promise<ExecuteRunResult> } | undefined;
let last: (ExecuteRunResult & { finishedAt: string }) | undefined;

/**
 * `runId`/`dateSlug` must be passed together when resuming, and must come from
 * the interrupted run's own state — NOT from today's date. An interrupted run
 * is usually yesterday's (that is what "interrupted" tends to mean overnight),
 * and defaulting to today made boot-resume load an empty workspace for today's
 * slug and fail with "nothing to resume" while the real interrupted run sat
 * untouched. Caught on the first live boot.
 */
function start(opts: {
  voice?: string;
  resume?: boolean;
  runId?: string;
  dateSlug?: string;
}): { runId: string; startedAt: string } {
  const startedAt = new Date().toISOString();
  const runId = opts.runId ?? `hn-${startedAt.slice(0, 10)}`;
  const promise = executeRun({
    voice: opts.voice,
    resume: opts.resume,
    runId: opts.runId,
    dateSlug: opts.dateSlug,
    onProgress: (m) => console.log(m),
  })
    .then((result) => {
      last = { ...result, finishedAt: new Date().toISOString() };
      console.log(`[server] run ${result.runId} finished: ${result.status}`);
      return result;
    })
    .catch((err) => {
      // executeRun is written not to throw, so reaching here means a defect in
      // it rather than a bad run. Record it and keep the server alive — a
      // crashed daemon is strictly worse than a failed run.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[server] run ${runId} threw unexpectedly: ${reason}`);
      const result: ExecuteRunResult = { status: "failed", runId, phase: "unknown", reason };
      last = { ...result, finishedAt: new Date().toISOString() };
      return result;
    })
    .finally(() => {
      active = undefined;
    });

  active = { runId, startedAt, promise };
  return { runId, startedAt };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /health") {
        return json(res, 200, { ok: true });
      }

      if (route === "GET /status") {
        return json(res, 200, {
          active: active ? { runId: active.runId, startedAt: active.startedAt } : null,
          last: last ?? null,
          voice: DEFAULT_VOICE,
        });
      }

      if (route === "POST /runs") {
        if (active) {
          // 409, not a queue. Two runs a day is not a workflow this project
          // has, so silently queueing one would hide a mistaken double-click
          // for however long the first run takes.
          return json(res, 409, {
            error: `Run ${active.runId} is already in progress (started ${active.startedAt}).`,
            runId: active.runId,
          });
        }
        const body = await readJson(req);
        const voice = typeof body.voice === "string" ? body.voice : undefined;
        const started = start({ voice, resume: body.resume === true });
        console.log(`[server] started run ${started.runId}`);
        return json(res, 202, started);
      }

      return json(res, 404, { error: `No route ${route}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[server] ${route} failed: ${message}`);
      return json(res, 500, { error: message });
    }
  })();
});

const port = config.server.port;

server.listen(port, "127.0.0.1", async () => {
  console.log(`kernelshorts server on http://127.0.0.1:${port}`);
  console.log(`dashboard: ${config.dashboardUrl ?? "run `pnpm dev` (http://localhost:3111)"}`);
  console.log(`voice: ${DEFAULT_VOICE}\n`);

  // Boot-time recovery: the job the old `--resume` flag did, minus the human.
  const resumable = await findResumableRun();
  if (resumable) {
    console.log(
      `[server] run ${resumable.run_id} was interrupted in phase "${resumable.phase}" ` +
        `and holds an approved script — resuming it.`,
    );
    start({ resume: true, runId: resumable.run_id, dateSlug: resumable.date_slug });
  } else {
    console.log(`[server] nothing to resume. POST /runs (or the dashboard) starts a run.`);
  }
});

/**
 * A run in flight owns a Palmier session and a half-written workspace, so the
 * first Ctrl-C asks it to finish and only stops accepting new work. A second
 * one is taken as "I meant now".
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      console.log(`\n[server] second ${signal} — exiting now.`);
      process.exit(1);
    }
    shuttingDown = true;
    server.close();
    if (active) {
      console.log(
        `\n[server] ${signal}: run ${active.runId} is still going. Waiting for it ` +
          `(Ctrl-C again to abandon it — the run is resumable on next boot).`,
      );
      void active.promise.finally(async () => {
        await closeDb();
        process.exit(0);
      });
    } else {
      void closeDb().then(() => process.exit(0));
    }
  });
}
