#!/bin/sh
# Run one foreground task. Remove sidebar-only leftovers, not other work.
"$@"
result=$?
# A Pi preview: redraw the Panels tab row of the Pi that owns it now, without this exiting pane.
if [ -n "$PI_PANELS_OWNER" ] && [ -n "$PI_TABS" ]; then
  node --no-warnings "$PI_TABS" refresh-pane "$TMUX_PANE" gone 2>/dev/null
fi
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  window=$(tmux display-message -p -t "$TMUX_PANE" '#{window_id}')
  panes=$(tmux list-panes -t "$window" -F '#{pane_id} #{pane_current_command}')
  others=$(printf '%s\n' "$panes" | awk -v owner="$TMUX_PANE" '$1 != owner && $2 != "ccmux" {print $1}')
  if [ -z "$others" ]; then
    # The task is finished and only its session selectors remain.
    printf '%s\n' "$panes" | awk -v owner="$TMUX_PANE" '$1 != owner {print $1}' |
      while IFS= read -r pane; do
        [ -n "$pane" ] && tmux kill-pane -t "$pane"
      done
  fi
fi
exit "$result"
