#!/usr/bin/env bash
# The e2e suite in two stages (Phase 15g):
#   1. `chromium` — everything but the CPU-hungry specs, in parallel;
#   2. `perf`     — stress board, budgets, soak, five-user realtime, restart —
#                   alone on one worker, so they don't starve stage 1's timing.
# Both stages always run, each writes its own HTML report, and the exit code
# is non-zero if either failed. Extra arguments go to both stages.
set -uo pipefail

PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/chromium npx playwright test --project=chromium "$@"
first=$?
PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/perf npx playwright test --project=perf --workers=1 "$@"
second=$?

exit $(( first != 0 || second != 0 ))
