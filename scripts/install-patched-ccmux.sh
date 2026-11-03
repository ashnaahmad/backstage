#!/bin/sh
# Builds ccmux v1.4.4 with the harness "+ New Pi" sidebar row (patches/ccmux-1.4.4-new-pi-row.patch)
# grouped-session handling (patches/ccmux-1.4.4-grouped-sessions.patch) and one bottom group for agent
# worktree sessions (patches/ccmux-1.4.4-worktrees-group.patch) and active-pane tracking through
# switch-client (patches/ccmux-1.4.4-switch-client-focus.patch), and installs it as ~/.local/bin/ccmux, ahead of the Homebrew ccmux on PATH, with ~/.local/bin/ccmux-pi,
# the launcher that row starts. Sets only agents.pi.executable in ccmux.json. Rollback is in SETUP.md.
# CCMUX_INSTALL_BIN and CCMUX_HOME redirect the install and the config (for a trial run).
set -eu
TAG=v1.4.4
COMMIT=643fe6a5642bdd08ba23af22cccd6df4d1f3c231
HARNESS=$(cd "$(dirname "$0")/.." && pwd)
PATCH="$HARNESS/patches/ccmux-1.4.4-new-pi-row.patch"
# One sidebar per window and one row per agent when grouped sessions (a view per terminal) share windows.
GROUPED="$HARNESS/patches/ccmux-1.4.4-grouped-sessions.patch"
# Sessions in `*-worktrees/<name>` folders share one collapsible group at the bottom, outside the attention band.
WORKTREES="$HARNESS/patches/ccmux-1.4.4-worktrees-group.patch"
# The highlighted (active) session follows a terminal moved by switch-client, not only by select-pane/window.
FOCUS="$HARNESS/patches/ccmux-1.4.4-switch-client-focus.patch"
SRC="${XDG_CACHE_HOME:-$HOME/.cache}/harness/ccmux-$TAG"
BIN="${CCMUX_INSTALL_BIN:-$HOME/.local/bin}"
CONFIG="${CCMUX_HOME:-$HOME/.config/ccmux}/ccmux.json"

command -v bun >/dev/null 2>&1 || { echo "install-patched-ccmux: needs bun (https://bun.sh)" >&2; exit 1; }
# ccmux types `exec <launcher>` into a login shell and refuses a quoted launcher for prompts, so the
# launcher's absolute path must need no quoting; a bare name would depend on that shell's PATH.
case "$BIN/ccmux-pi" in
  *[!A-Za-z0-9/._-]*) echo "install-patched-ccmux: $BIN has characters a shell would need quoted; set CCMUX_INSTALL_BIN to a plain path" >&2; exit 1 ;;
esac
rm -rf "$SRC"
mkdir -p "$(dirname "$SRC")"
git clone --quiet --depth 1 --branch "$TAG" https://github.com/epilande/ccmux.git "$SRC" 2>/dev/null
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || { echo "install-patched-ccmux: $TAG is not $COMMIT" >&2; exit 1; }
git -C "$SRC" apply "$PATCH"
git -C "$SRC" apply "$GROUPED"
git -C "$SRC" apply "$WORKTREES"
git -C "$SRC" apply "$FOCUS"
cd "$SRC"
bun install --frozen-lockfile
# The tests must not reach the caller's tmux server or ccmux files: some send real tmux commands
# (including kill-pane) and write under ~/.config/ccmux. A run from inside tmux once killed a live Pi.
TEST_HOME=$(mktemp -d)
env -u TMUX -u TMUX_PANE -u CCMUX_TMUX_SOCKET HOME="$TEST_HOME" CCMUX_HOME="$TEST_HOME/ccmux" \
  TMUX_TMPDIR="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/config" XDG_STATE_HOME="$TEST_HOME/state" CCMUX_PORT=42269 \
  bun test src/tui/utils/grouping.test.ts src/tui/components/GroupHeader.test.tsx src/daemon/spawn-command.test.ts \
  src/commands/sidebar.test.ts src/daemon/pane-discovery.test.ts src/lib/tmux-client.grouped.test.ts src/tui/utils/client-switch.test.ts src/tui/utils/tmux.test.ts
rm -rf "$TEST_HOME"
bun run build
bun build dist/index.js --compile --no-compile-autoload-bunfig --outfile "$SRC/ccmux"
[ "$("$SRC/ccmux" --version)" = "${TAG#v}" ]

# ccmux types the agent command into a new shell; `exec` replaces that shell, so when Pi quits the
# task wrapper closes the window, sidebar included.
mkdir -p "$BIN"
quoted=$(printf %s "$HARNESS/scripts/tmux-task.sh" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\n# Pi from the ccmux "+ New Pi" row (harness scripts/install-patched-ccmux.sh).\nexec '"'"'%s'"'"' pi "$@"\n' "$quoted" > "$BIN/ccmux-pi.new"
chmod +x "$BIN/ccmux-pi.new"
mv -f "$BIN/ccmux-pi.new" "$BIN/ccmux-pi"
cp "$SRC/ccmux" "$BIN/ccmux.new"
mv -f "$BIN/ccmux.new" "$BIN/ccmux"

launch="$BIN/ccmux-pi"
mkdir -p "$(dirname "$CONFIG")"
node -e '
const fs = require("fs"), [file, value] = process.argv.slice(1);
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
config.agents ??= {};
config.agents.pi = { ...config.agents.pi, executable: value };
fs.writeFileSync(file + ".new", JSON.stringify(config, null, 2) + "\n");
fs.renameSync(file + ".new", file);
' "$CONFIG" "exec $launch"

echo "Installed $BIN/ccmux ($TAG + harness patch) and $BIN/ccmux-pi; agents.pi.executable = exec $launch in $CONFIG."
echo "Restart the ccmux daemon and sidebars to use them (SETUP.md)."
