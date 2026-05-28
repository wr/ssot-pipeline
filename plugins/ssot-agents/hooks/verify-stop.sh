#!/usr/bin/env bash
# Stop hook: additive in-session self-correction. When a workflow opts in by
# setting SSOT_VERIFY_KIND, call the Worker /verify endpoint; if the expected
# outcome isn't met yet, block ONCE with a reason so the agent fixes it before
# the run ends.
#
# This never replaces the workflow's own `if: always()` verify step — that
# remains the authoritative backstop and owns the Stuck/auto-replan handling.
# So this hook is fail-open everywhere: any missing input, infra error, bad
# response, or second pass just allows the stop. It can only ever ADD a
# correction attempt, never wedge or weaken the run.
set -euo pipefail

INPUT=$(cat 2>/dev/null || true)

# Block at most once: the Stop that follows the agent's correction attempt
# carries stop_hook_active=true. Never block then — let it stop and let the
# backstop verify decide the authoritative outcome.
ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)
[ "$ACTIVE" = "true" ] && exit 0

KIND="${SSOT_VERIFY_KIND:-}"
[ -n "$KIND" ] || exit 0           # workflow didn't opt in to early verify
[ -n "${ISSUE:-}" ] || exit 0      # nothing to verify against
[ -n "${CONFIG_URL:-}" ] || exit 0 # no Worker URL to reach /verify

VERIFY_URL="${CONFIG_URL%/config}/verify"
RESP=$(curl -fsS -m 8 "${VERIFY_URL}?issue=${ISSUE}&kind=${KIND}" 2>/dev/null) || exit 0
printf '%s' "$RESP" | jq -e . >/dev/null 2>&1 || exit 0

PASS=$(printf '%s' "$RESP" | jq -r '.pass // true')
[ "$PASS" = "true" ] && exit 0

REASON=$(printf '%s' "$RESP" | jq -r '.reason // "expected outcome not met"')
jq -nc --arg r "Before you finish: ${REASON}. Do that now, then stop." \
  '{decision:"block",reason:$r}'
