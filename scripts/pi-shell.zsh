# Source from ~/.zshrc. Bare interactive pi starts a ccmux-visible window.
pi() {
  if [[ -n "$TMUX" || ! -t 0 || ! -t 1 ]] || (( $# )); then
    command pi "$@"
    return $?
  fi
  local pi_binary="${commands[pi]}"
  if [[ -z "$pi_binary" ]] || (( ! $+commands[tmux] )); then
    print -u2 'Pi and tmux must both be installed.'
    return 127
  fi
  local pi_runner="${${(%):-%x}:A:h}/tmux-task.sh"
  local pi_window
  if command tmux has-session -t '=pi-workspace' 2>/dev/null; then
    pi_window=$(command tmux new-window -dP -F '#{window_id}' \
      -t pi-workspace -n Pi -c "$PWD" "${(q)pi_runner} ${(q)pi_binary}") || return
  else
    pi_window=$(command tmux new-session -dP -F '#{window_id}' \
      -s pi-workspace -n Pi -c "$PWD" "${(q)pi_runner} ${(q)pi_binary}") || return
  fi
  # Each terminal attaches its own view of pi-workspace: the same windows, its own current window, so
  # another terminal showing the workspace stays where it is. The view closes when this terminal leaves
  # it (set once attached: an unattached session with destroy-unattached closes at once).
  local pi_view
  pi_view=$(command tmux new-session -dP -F '#{session_id}' -t '=pi-workspace') || return
  command tmux select-window -t "$pi_view:$pi_window" || return
  command tmux attach-session -t "$pi_view" \; set-option -t "$pi_view" destroy-unattached on
}
