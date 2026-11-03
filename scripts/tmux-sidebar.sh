#!/bin/sh
# Ctrl+Q for one window (tmux/pi-tabs.conf): closes the ccmux sidebar in that window, or opens one as
# `ccmux sidebar --toggle` would, at the configured width and side. ccmux's own toggle acts on every
# window, which with a view per terminal changes the other screen too; this leaves other windows alone.
# `narrower`/`wider` (the mobile page's buttons, tmux/mobile.conf) change that window's sidebar width
# until it closes; `hook` only registers the resize hook below.
#   tmux-sidebar.sh <window id> [narrower|wider]
#   tmux-sidebar.sh - hook
set -eu
window=$1
# Width and side from ccmux's preferences (its defaults: 30, left).
config="${CCMUX_HOME:-$HOME/.config/ccmux}/ccmux.json"
set -- "${2:-}" $(node -e '
let s = {};
try { s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sidebar ?? {}; } catch {}
const width = Number.isInteger(s.width) && s.width > 0 ? s.width : 30;
console.log(width, s.position === "right" ? "-fhd" : "-fhbd");
' "$config")
# Keeps sidebars at their width when a window resizes: ccmux's own hook, as its global toggle registers
# it (src/commands/sidebar.ts, resizeHookCommand), except that a window's @pi_sidebar_width replaces the
# configured width, and a zoomed window is left alone (resize-pane would unzoom it, as a phone keyboard
# opening resizes the window). A dragged width rewrites it while it is registered.
hook() {
  tmux set-hook -g 'window-resized[99]' "run-shell -b 'tmux -S \"#{socket_path}\" list-panes -t \"#{hook_window}\" -F \"##{pane_id} ##{@pi_sidebar_width}\" -f \"##{&&:##{==:##{pane_title},ccmux-sidebar},##{!=:##{window_zoomed_flag},1}}\" 2>/dev/null | while read -r p w; do tmux -S \"#{socket_path}\" resize-pane -t \"\$p\" -x \"\${w:-$2}\" 2>/dev/null; done'"
}
[ "$1" = hook ] && { hook "$@"; exit 0; }
sidebars=$(tmux list-panes -t "$window" -F '#{pane_id} #{pane_title}' | awk '$2 == "ccmux-sidebar" { print $1 }')
case $1 in
  narrower|wider)
    for pane in $sidebars; do
      width=$(tmux display-message -p -t "$pane" '#{pane_width}')
      if [ "$1" = wider ]; then width=$((width + 5)); else width=$((width > 15 ? width - 5 : 10)); fi
      tmux set-option -w -t "$window" @pi_sidebar_width "$width"
      tmux resize-pane -t "$pane" -x "$width"
      hook "$@"
    done
    exit 0 ;;
esac
# Opening or closing restores the configured width.
tmux set-option -wu -t "$window" @pi_sidebar_width
if [ -n "$sidebars" ]; then
  for pane in $sidebars; do tmux kill-pane -t "$pane"; done
  exit 0
fi
# Starts in the directory of the window's active pane, as ccmux does.
path=$(tmux display-message -p -t "$window" '#{pane_current_path}')
tmux split-window "$3" -l "$2" -c "$path" -t "$window" 'sleep 0.10 && exec ccmux sidebar'
hook "$@"
