#!/usr/bin/env bash
# Keep generating a character's poses across Gemini quota windows until done.
#   scripts/gen-host-until-done.sh <character> [initial-wait-seconds] [pose ids...]
# gen-host exits 2 when the free image quota is exhausted; we then wait one
# window (~4h55m) and continue. Finished poses are never regenerated.
set -u
cd "$(dirname "$0")/.."
character="$1"; shift
initial="${1:-0}"; shift || true
[ "$initial" -gt 0 ] && sleep "$initial"
for attempt in 1 2 3 4 5; do
  pnpm exec tsx scripts/gen-host.ts --character "$character" "$@"
  rc=$?
  [ "$rc" -ne 2 ] && break
  echo "[$(date +%H:%M)] quota hit (attempt $attempt); waiting for the next window"
  sleep 17700
done
pnpm exec tsx scripts/host-measure.ts | grep "^$character"
