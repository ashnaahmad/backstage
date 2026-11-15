#!/bin/sh
# Run one foreground task. Remove sidebar-only leftovers, not other work.
"$@"
result=$?
# A Pi preview: redraw the Panels tab row of the Pi that owns it now, without this exiting pane.
if [ -n "$PI_PANELS_OWNER" ] && [ -n "$PI_TABS" ]; then
  node --no-warnings "$PI_TABS" refresh-pane "$TMUX_PANE" gone 2>/dev/null
fi
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  # This task has finished: marked before looking, so when tasks in one window finish together, the last
  # to look sees every other one finished. The mark names this process, which runs the pane until it
  # exits, so a pane respawned with something else is not taken for finished.
  tmux set-option -p -t "$TMUX_PANE" @pi_task_done "$$" 2>/dev/null
  window=$(tmux display-message -p -t "$TMUX_PANE" '#{window_id}')
  panes=$(tmux list-panes -t "$window" -F '#{pane_id} #{pane_current_command} #{pane_pid} #{@pi_task_done}')
  others=$(printf '%s\n' "$panes" | awk -v owner="$TMUX_PANE" '$1 != owner && $2 != "ccmux" && !($4 != "" && $3 == $4) {print $1}')
  if [ -z "$others" ]; then
    # Every task here has finished and only session selectors remain with them.
    printf '%s\n' "$panes" | awk -v owner="$TMUX_PANE" '$1 != owner && $2 == "ccmux" {print $1}' |
      while IFS= read -r pane; do
        [ -n "$pane" ] && tmux kill-pane -t "$pane" 2>/dev/null
      done
  fi
fi
exit "$result"
