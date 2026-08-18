#!/usr/bin/env bash
# PreToolUse guard: enforce UNIVERSAL invariants.
#
# Hooks cannot identify which subagent triggered a call -- verified against
# current docs (open item O-3, now closed). The input JSON carries session_id,
# prompt_id, cwd and tool_name, but nothing naming the agent. So only encode
# rules that hold no matter who is acting. Per-persona path ownership is
# enforced by CODEOWNERS at review time, which is the only genuinely hard tier.
#
# WHY THIS HOOK CARRIES THE COMMAND RULES AND settings.json DOES NOT:
# `permissions.deny` matching is prefix-based over the command string and fails
# OPEN on ordinary variations -- `npx wrangler deploy` is not blocked by
# `Bash(wrangler deploy:*)` because npx is not in the wrapper-stripping list
# (only timeout, time, nice, nohup, stdbuf, command, builtin, noglob are).
# Extra whitespace, `--env=prod`, variable expansion, and commands inside a
# script body all slip through too. A guard that fails open silently is worse
# than no guard, because you believe you are protected.
#
# This hook inspects the full command text instead, and fails CLOSED.
#
# Contract (verified): stdin is a JSON object; for Write/Edit the path is at
# .tool_input.file_path, for Bash the command is at .tool_input.command.
# Exit 2 blocks the call and returns stderr to the model as the reason.
# Exit 0 allows. Any other exit is a non-blocking notice.

set -uo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

block() {
  echo "BLOCKED: $1" >&2
  exit 2
}

# --------------------------------------------------------------------------
# File writes
# --------------------------------------------------------------------------
if [ "$tool" = "Write" ] || [ "$tool" = "Edit" ] || [ "$tool" = "NotebookEdit" ]; then
  path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
  [ -z "$path" ] && exit 0

  case "$path" in
    # Self-modification loop: no agent rewrites its own constraints.
    *.claude/*|*.github/workflows/*)
      block "agent constraints and CI workflows require human review (CODEOWNERS)." ;;
    # Public repo: non-redistributable data must never be committed.
    *.parquet|*.csv|*.db|*.sqlite|*.sqlite3|*/data/*)
      block "data files must not enter the public repository." ;;
    # A generated D1 seed is a data file wearing a costume.
    *_seed.sql)
      block "the generated D1 seed is gitignored; it must not be written into a tracked path." ;;
    # Secrets never in tree. football-data.org ToS 6.1 forbids keys in OSS repos.
    *.env|*.env.*|*.dev.vars|*.pem)
      block "secrets belong in Secrets Store / GitHub Environment secrets." ;;
  esac
  exit 0
fi

# --------------------------------------------------------------------------
# Shell commands
# --------------------------------------------------------------------------
if [ "$tool" = "Bash" ]; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
  [ -z "$cmd" ] && exit 0

  # Normalize so trivial variation cannot evade the match: collapse all
  # whitespace, strip common runner prefixes anywhere in the string, and
  # fold `--env=x` to `--env x`.
  norm=$(printf '%s' "$cmd" \
    | tr '\n\t' '  ' \
    | sed -E 's/  +/ /g; s/(^| )(npx|pnpm dlx|yarn dlx|bunx|uvx) +/\1/g; s/=/ /g')

  # Deploys and remote mutations are human-only, on a laptop, behind the
  # production Environment gate. The agent never holds CF_TOKEN_PROD, but it
  # should not be able to reach a dev deploy either.
  case "$norm" in
    *"wrangler deploy"*|*"wrangler versions upload"*)
      block "deploys are human-only and gated by the production Environment. Open a PR instead." ;;
    *"wrangler d1 execute"*"--remote"*|*"wrangler d1 migrations apply"*)
      block "remote D1 mutations are laptop-only. Local (--local) is fine; this is not." ;;
    *"wrangler secret"*)
      block "secret handling is human-only. Never route a secret through an agent context." ;;
    *"wrangler r2 object delete"*|*"wrangler kv key delete"*)
      block "destructive resource commands require human review." ;;
  esac

  # History rewriting destroys the audit trail the whole model depends on.
  case "$norm" in
    *"git push --force"*|*"git push -f"*)
      block "force-push is blocked; the ruleset on main forbids it anyway." ;;
    *"git reset --hard"*)
      block "hard reset discards work. Do this yourself if you mean it." ;;
  esac

  # Writing to guarded paths via the shell rather than the Write tool.
  case "$norm" in
    *">"*".claude/"*|*">"*".github/workflows/"*|*"tee"*".claude/"*)
      block "shell redirection into .claude/ or .github/workflows/ is still self-modification." ;;
  esac

  exit 0
fi

exit 0
