#!/bin/sh
# Gives a tmux client its own view when it shares a session with another client: a session grouped
# with that one (the same windows) whose current window is its own, so two terminals (a monitor and
# the laptop screen) can show different windows. The view starts at the window the client was shown
# and closes when the client leaves it. Run by tmux/pi-tabs.conf when a client attaches or changes
# session; a client alone in its session is left as it is.
#   tmux-view.sh <client name>
set -eu
client=$1
# By client name, not `display-message -c`: that expands formats against the default session,
# which with two clients can be the other client's.
session=$(tmux list-clients -F '#{client_name}	#{session_id}' | awk -F '	' -v c="$client" '$1 == c { print $2 }')
[ -n "$session" ] || exit 0
[ "$(tmux list-clients -t "$session" -F x | wc -l)" -gt 1 ] || exit 0
window=$(tmux display-message -p -t "$session" '#{window_id}')
view=$(tmux new-session -d -P -F '#{session_id}' -t "$session")
tmux select-window -t "$view:$window"
tmux switch-client -c "$client" -t "$view"
# Only once attached: an unattached session with this option closes at once.
tmux set-option -t "$view" destroy-unattached on
