#!/usr/bin/env bash
# SessionStart hook: fetch pipeline config from the Worker and inject it as
# additionalContext, so skills get config (plan marker, state names, branch
# prefix, review-bot login) without the workflow passing it per-request.
#
# Silent no-op (exit 0, no output) if CONFIG_URL is unset or the fetch fails —
# the run then proceeds without injected config. Skills must still degrade
# gracefully if a value is absent.
#
# Output contract (Claude Code SessionStart hook): a single JSON object on
# stdout with hookSpecificOutput.additionalContext. Top-level additionalContext
# is NOT honored — it must be nested under hookSpecificOutput.
set -euo pipefail

[ -n "${CONFIG_URL:-}" ] || exit 0
CFG=$(curl -fsS -m 8 "$CONFIG_URL" 2>/dev/null) || exit 0
[ -n "$CFG" ] || exit 0
printf '%s' "$CFG" | jq -e . >/dev/null 2>&1 || exit 0

CTX=$(printf '%s' "$CFG" | jq -r '
  "Pipeline config (from the SSOT Worker /config endpoint). Where this skill refers to the plan marker, the needs-input marker, a Linear state name, the branch prefix, or the review-bot login, use these values:\n" +
  "- plan marker (use verbatim as the first line of plan comments): \(.plan_marker // "(unset)")\n" +
  "- needs-input marker (use verbatim as the first line of a comment when you park an issue awaiting user input): \(.needs_input_marker // "(unset)")\n" +
  "- planning state: \(.planning_state // "(unset)")\n" +
  "- plan-review state: \(.plan_review_state // "(unset)")\n" +
  "- in-progress state: \(.in_progress_state // "(unset)")\n" +
  "- in-review state: \(.in_review_state // "(unset)")\n" +
  "- stuck state: \(.stuck_state // "(unset)")\n" +
  "- branch prefix: \(.branch_prefix // "(unset)")\n" +
  "- review bot login: \(.review_bot_login // "(unset)")"
')

jq -nc --arg c "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
