# kernelshorts

## Rendering

The edit phase composes an HTML project and renders it headlessly with
HyperFrames — there is no desktop NLE and no GUI app to keep open. Two
runtime dependencies fall out of that:

- **Playwright/Chromium is a hard dependency of every run.** The caption
  safe-area verifier launches a real browser to measure text layout on the
  composed project. If Chromium fails to launch, the review loop aborts by
  design rather than degrading to an unearned pass — there is no fallback
  path that skips this check.
- **The first `hyperframes transcribe` downloads a ~487MB Whisper model.**
  This is a one-time cost per machine; budget for it before the first real
  run.

The `hyperframes` CLI itself is a **pinned devDependency** (currently
`0.8.27` — see `package.json`), not something fetched at call time. `render`
and `transcribeVoiceover` both invoke it via `pnpm exec hyperframes …`, which
runs the version installed in this project's `node_modules`, never whatever
`npx`/npm's registry would otherwise resolve on the day a render happens —
the same guarantee `GSAP_SRC` gives the compositor. Bumping the CLI version
is a deliberate `pnpm add -D -E hyperframes@<version>`, not something that
happens silently between runs.

Two commands run this: `pnpm server` (the daemon) and `pnpm dev` (the
dashboard).

## Checking a change end to end

- `scripts/acceptance.ts` — the end-to-end headless smoke test. Re-runs the
  edit → review (Layer 1) → deliverable-gate path against a real completed
  run's artifacts (read-only), so it re-proves the whole deterministic path
  after any change:

  ```
  pnpm exec tsx scripts/acceptance.ts <run-id> [--runs-root <dir>] [--out <dir>]
  # e.g.
  pnpm exec tsx scripts/acceptance.ts 2026-08-18
  ```

  It writes its scratch output to `.acceptance/` (gitignored) and never
  touches `~/pipeline/runs`. Layer 2 (the vision reviewer) is deliberately
  skipped — see the script's header for why.

- `scripts/parity.ts` — builds and renders a run with the current backend and
  diffs it against an archived baseline export, for checking that a change
  hasn't shifted timing, sizing, or other measurable output.
