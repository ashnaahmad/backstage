#!/bin/zsh
# claude-companion — call Claude Code headless from another agent (Codex) with the same ergonomics as codex-companion.
#
#   claude-companion.sh ask [--session <id>|--new] [--tools ro|none|all] [--add-dir <dir>]... [--cwd <dir>]
#                           [--model <model>] [--background] [--prompt-file <path>] [prompt]
#   claude-companion.sh status [<job-id>] [--wait] [--timeout <seconds>]
#   claude-companion.sh result <job-id>
#   claude-companion.sh sessions
#
# `ask` prints the reply and, on the last lines, `Claude session ID: <id>` — continue that exact session later with
# `--session <id>` (Claude keeps its own context; send only the new message). `--tools ro` = Read/Grep/Glob only
# (default); `none` = no tools; `all` = default tool set with dontAsk permissions inside --add-dir roots.
# Codex-originated asks explicitly use Fable by default, independent of Claude's user settings. Override per call with
# --model, or for all calls in a process with CLAUDE_COMPANION_MODEL.
# Foreground asks write no files (Codex's task sandbox is read-only). Only --background/status/result use
# $CLAUDE_COMPANION_STATE (default ~/.claude-companion/jobs) for <job>.meta/.json/.log.
set -u
STATE=${CLAUDE_COMPANION_STATE:-$HOME/.claude-companion/jobs}
# Sandboxed callers (Codex tasks) cannot reach the macOS Keychain where Claude's OAuth lives, so a long-lived token
# from `claude setup-token` is read from a 0600 file unless CLAUDE_CODE_OAUTH_TOKEN is already in the environment.
TOKEN_FILE=${CLAUDE_COMPANION_TOKEN_FILE:-$HOME/.claude-companion/token}
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r "$TOKEN_FILE" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"; fi
cmd=${1:-}; shift || true
die(){ echo "claude-companion: $*" >&2; exit 2; }
RENDER='import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("(no JSON result: %s)" % e); sys.exit(1)
r = d.get("result") or ""
if "Not logged in" in r or d.get("api_error_status") == 401:
    print("claude-companion: Claude is not authenticated in this process (sandboxed keychain?). Put a `claude setup-token` token in ~/.claude-companion/token, or run from a session with keychain access."); sys.exit(3)
if d.get("is_error") or "reach the API server" in r or "ENOTFOUND" in r:
    print("claude-companion: the call failed before Claude answered (no session to continue): %s" % r.strip()[:300]); sys.exit(4)
print(r)
print()
print("Claude session ID: %s" % d.get("session_id"))
print("Continue with: claude-companion.sh ask --session %s <prompt>" % d.get("session_id"))'

case "$cmd" in
  ask)
    session=""; new=0; tools=ro; adddirs=(); cwd="$PWD"; model="${CLAUDE_COMPANION_MODEL:-fable}"; background=0; pfile=""; prompt=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --session) session="$2"; shift 2;;
        --new) new=1; shift;;
        --tools) tools="$2"; shift 2;;
        --add-dir) adddirs+=("$2"); shift 2;;
        --cwd) cwd="$2"; shift 2;;
        --model) model="$2"; shift 2;;
        --background) background=1; shift;;
        --prompt-file) pfile="$2"; shift 2;;
        --) shift; prompt="$*"; break;;
        *) prompt="${prompt:+$prompt }$1"; shift;;
      esac
    done
    [ -n "$pfile" ] && prompt="$(cat "$pfile")"
    [ -z "$prompt" ] && [ ! -t 0 ] && prompt="$(cat)"
    [ -z "$prompt" ] && die "provide a prompt, --prompt-file, or piped stdin"
    [ -n "$session" ] && [ $new -eq 1 ] && die "--session and --new are exclusive"
    args=(-p --output-format json)
    case "$tools" in
      ro) args+=(--allowedTools Read Grep Glob --tools Read,Grep,Glob --permission-mode dontAsk);;
      none) args+=(--tools "");;
      all) args+=(--permission-mode dontAsk);;
      *) die "--tools must be ro|none|all";;
    esac
    for d in "${adddirs[@]}"; do args+=(--add-dir "$d"); done
    [ -n "$model" ] && args+=(--model "$model")
    [ -n "$session" ] && args+=(--resume "$session")
    if [ $background -eq 1 ]; then
      mkdir -p "$STATE" 2>/dev/null || die "cannot write $STATE (read-only sandbox?) — use foreground, which writes no files"
      job="claude-$(date +%s)-$RANDOM"
      printf '{"job":"%s","status":"running","cwd":"%s","session":"%s"}\n' "$job" "$cwd" "$session" > "$STATE/$job.meta"
      ( ( cd "$cwd" && printf '%s' "$prompt" | claude "${args[@]}" ) > "$STATE/$job.json" 2> "$STATE/$job.log"; printf '{"job":"%s","status":"completed"}\n' "$job" > "$STATE/$job.meta" ) > /dev/null 2>&1 &
      echo "Claude task started in the background as $job. Check: claude-companion.sh status $job --wait; result: claude-companion.sh result $job"
    else
      ( cd "$cwd" && printf '%s' "$prompt" | claude "${args[@]}" 2>/dev/null ) | python3 -c "$RENDER"
    fi;;
  status)
    job=${1:-}; shift || true; wait=0; timeout=1800
    while [ $# -gt 0 ]; do case "$1" in --wait) wait=1; shift;; --timeout) timeout="$2"; shift 2;; *) shift;; esac; done
    if [ -z "$job" ]; then ls -t "$STATE"/*.meta 2>/dev/null | head -10 | while read -r m; do cat "$m"; done; exit 0; fi
    [ -f "$STATE/$job.meta" ] || die "no job $job"
    w=0; while [ $wait -eq 1 ] && ! grep -q '"completed"' "$STATE/$job.meta" && [ $w -lt $timeout ]; do sleep 10; w=$((w+10)); done
    cat "$STATE/$job.meta";;
  result)
    job=${1:-}; [ -n "$job" ] || die "job id required"; [ -f "$STATE/$job.json" ] || die "no result yet for $job"
    python3 -c "$RENDER" < "$STATE/$job.json";;
  sessions)
    for f in $(ls -t "$STATE"/*.json 2>/dev/null | head -20); do python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('session_id'), '|', (d.get('result') or '')[:80].replace(chr(10),' '))" "$f"; done;;
  *) sed -n '2,14p' "$0"; exit 2;;
esac
