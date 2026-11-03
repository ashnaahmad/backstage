#!/bin/sh
# The mobile page's Sessions, Agent and Preview buttons (tmux/mobile.conf): makes the window's sessions
# sidebar, Pi pane, or Markdown editor / diff pane the active one, keeping Focus (zoom) if it is on.
# Panes are recognised by what already marks them: the sidebar's title, and the pane options Pi's
# extension sets (scripts/lib/diff-pane.ts). Repeated presses keep the active matching pane. Bottom tabs choose documents, diffs and sessions.
# Nothing is opened: without a match, the pressing client is told so.
#   tmux-mobile-select.sh <window id> <client name> sessions|agent|preview
set -eu
window=$1 client=$2 kind=$3
case $kind in
  sessions) label='Sessions sidebar' ;;
  agent) label='Pi' ;;
  preview) label='Markdown editor or diff' ;;
  *) exit 2 ;;
esac
next=$(tmux list-panes -t "$window" -F '#{pane_id}	#{pane_active}	#{pane_title}	#{@pi_owner}	#{@pi_doc_server}	#{@pi_diff_owner}' |
  awk -F '	' -v kind="$kind" '
    (kind == "sessions" && $3 == "ccmux-sidebar") || (kind == "agent" && $4 != "") ||
    (kind == "preview" && ($5 != "" || $6 != "")) { if (!first) first = $1; if ($2 == "1") active = $1 }
    END { if (first) print active ? active : first }')
if [ -z "$next" ]; then
  tmux display-message -c "$client" "No $label pane in this window"
  exit 0
fi
tmux select-pane -Z -t "$next"
