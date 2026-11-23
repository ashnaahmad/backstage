#!/bin/sh
# Install (or remove) a daily launchd job that runs prune-worktree-deps.py --apply
# against one repository's worktrees.
#   install-prune-worktree-deps.sh <main checkout> [HH:MM]   (default 03:30)
#   install-prune-worktree-deps.sh --remove <main checkout>
set -eu
remove=
if [ "${1:-}" = --remove ]; then remove=1; shift; fi
repo=$(cd "${1:?usage: $0 [--remove] <main checkout> [HH:MM]}" && pwd)
at=${2:-03:30}
hour=${at%%:*}; minute=${at##*:}
harness=$(cd "$(dirname "$0")/.." && pwd)
name=$(basename "$repo")
label="local.pi-harness.prune-worktree-deps.$name"
plist="$HOME/Library/LaunchAgents/$label.plist"
state="$HOME/.local/state/prune-worktree-deps"

launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
if [ -n "$remove" ]; then rm -f "$plist"; echo "removed $label"; exit 0; fi

mkdir -p "$state" "$(dirname "$plist")"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v python3)</string><string>-I</string><string>-u</string>
    <string>$harness/scripts/prune-worktree-deps.py</string>
    <string>--repo</string><string>$repo</string><string>--apply</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <!-- The installing shell's, so the job finds the same git and gh. -->
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>$((10#$hour))</integer><key>Minute</key><integer>$((10#$minute))</integer>
  </dict>
  <key>StandardOutPath</key><string>$state/$name.log</string>
  <key>StandardErrorPath</key><string>$state/$name.log</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label: daily at $at, log $state/$name.log"
