#!/bin/sh
# The Pi workspace in a phone browser: ttyd on loopback, with the mobile page (mobile/page.js), as a
# login service (macOS LaunchAgent), published to this tailnet only through Tailscale Serve.
#   mobile-terminal.sh install [session]   start now and at each login; add the Serve route
#   mobile-terminal.sh uninstall           stop it, remove the LaunchAgent and this Serve route
#   mobile-terminal.sh status
# The service runs `run`, and ttyd runs `attach` for each connection, from a copy of the files they use
# in ~/.local/share/pi-mobile-terminal: macOS refuses a LaunchAgent access to ~/Documents and similar
# folders where the checkout may be. `install` refreshes the copy.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
label=${PI_MOBILE_LABEL:-local.pi-harness.mobile-terminal}
port=${PI_MOBILE_PORT:-7681}
https_port=${PI_MOBILE_HTTPS_PORT:-8443}
target=http://127.0.0.1:$port
state=${PI_MOBILE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-mobile-terminal}
plist=$HOME/Library/LaunchAgents/$label.plist
installed=${PI_MOBILE_SHARE:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-mobile-terminal}
files='scripts/mobile-terminal.sh scripts/tmux-sidebar.sh scripts/tmux-mobile-select.sh tmux/mobile.conf mobile/page.js'
domain=gui/$(id -u)

# A value for the LaunchAgent's XML.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# This port's Tailscale Serve route: none, ours (only this proxy at /), funnel (public), other, or
# unknown when its configuration cannot be read.
serve_state() {
  config=$(tailscale serve status --json 2>/dev/null) || { echo unknown; return; }
  printf '%s' "$config" | node -e '
const [port, target] = process.argv.slice(1);
let s;
try { s = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { console.log("unknown"); process.exit(); }
const mine = key => key.endsWith(":" + port);
const web = Object.entries(s.Web ?? {}).filter(([key]) => mine(key));
if (Object.entries(s.AllowFunnel ?? {}).some(([key, on]) => on && mine(key))) console.log("funnel");
else if (!s.TCP?.[port] && !web.length) console.log("none");
else {
  const handlers = Object.entries(web[0]?.[1].Handlers ?? {});
  const ours = s.TCP?.[port]?.HTTPS && web.length === 1 && handlers.length === 1
    && handlers[0][0] === "/" && handlers[0][1].Proxy === target;
  console.log(ours ? "ours " + web[0][0] : "other");
}' "$https_port" "$target"
}

case ${1:-} in
  install)
    session=${2:-pi-workspace}
    [ "$root" != "$installed" ] || { echo "Run install from the checkout, not the installed copy." >&2; exit 1; }
    for tool in ttyd tmux node curl tailscale; do
      command -v "$tool" >/dev/null || { echo "$tool is not on PATH." >&2; exit 1; }
    done
    case $(serve_state) in
      funnel|other) echo "Tailscale Serve port $https_port is already in use: tailscale serve status" >&2; exit 1 ;;
      unknown) echo "Could not read Tailscale Serve's configuration: tailscale serve status" >&2; exit 1 ;;
    esac
    if ! launchctl print "$domain/$label" >/dev/null 2>&1 && nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "Port $port is in use by another process; stop it first." >&2; exit 1
    fi
    # The tmux server this shell's tmux reaches (none running: tmux's default when the service runs).
    socket=$(tmux display-message -p '#{socket_path}' 2>/dev/null || true)
    mkdir -p "$state" "$(dirname "$plist")" "$(dirname "$installed")"
    # The new copy, beside the one a running service uses until it is replaced.
    rm -rf "$installed.new"
    for file in $files; do
      mkdir -p "$installed.new/$(dirname "$file")"
      cp "$root/$file" "$installed.new/$file"
    done
    cat > "$plist.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$(xml "$label")</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>$(xml "$installed/scripts/mobile-terminal.sh")</string><string>run</string><string>$(xml "$session")</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <!-- The installing shell's, so the service finds the same ttyd, tmux and node (launchd's omits Homebrew). -->
    <key>PATH</key><string>$(xml "$PATH")</string>
    <key>PI_MOBILE_PORT</key><string>$(xml "$port")</string>
    <key>PI_MOBILE_STATE</key><string>$(xml "$state")</string>
    <key>PI_MOBILE_TMUX_SOCKET</key><string>$(xml "$socket")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$state/ttyd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$state/ttyd.log")</string>
</dict></plist>
EOF
    # Checked before the running service is replaced.
    plutil -lint -s "$plist.new" || { rm -rf "$plist.new" "$installed.new"; exit 1; }
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -rf "$installed"
    mv "$installed.new" "$installed"
    mv "$plist.new" "$plist"
    launchctl bootstrap "$domain" "$plist"
    [ "$(serve_state)" = none ] && tailscale serve --bg --https="$https_port" "$target" >/dev/null
    sh "$0" status ;;

  uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist"
    rm -rf "$installed" "$installed.new"
    case $(serve_state) in
      ours*) tailscale serve --https="$https_port" off >/dev/null ;;
      none) ;;
      *) echo "Left Tailscale Serve port $https_port alone: it is not only this route, or unreadable." >&2 ;;
    esac
    echo "Mobile terminal removed." ;;

  status)
    if launchctl print "$domain/$label" 2>/dev/null | grep -q 'state = running'; then echo "Service: running"
    elif [ -f "$plist" ]; then echo "Service: installed, not running (log: $state/ttyd.log)"
    else echo "Service: not installed"; fi
    case $(serve_state) in
      ours*) set -- $(serve_state); echo "URL: https://$2 (tailnet only)" ;;
      none) echo "Tailscale Serve: no route on port $https_port" ;;
      unknown) echo "Tailscale Serve: configuration unreadable" ;;
      *) echo "Tailscale Serve: port $https_port serves something else" ;;
    esac ;;

  run)
    # ttyd's own page, from a throwaway ttyd on a socket, plus the viewport tag and the mobile page.
    session=$2
    mkdir -p "$state"
    rm -f "$state/stock.sock"
    ttyd -i "$state/stock.sock" true >/dev/null 2>&1 &
    stock=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "$state/stock.sock" ] && break; sleep 0.2; done
    curl -sf --max-time 10 --unix-socket "$state/stock.sock" http://localhost/ > "$state/stock.html" || true
    kill "$stock" 2>/dev/null || true
    node -e '
const fs = require("fs");
const [stock, script, out] = process.argv.slice(1);
const page = fs.readFileSync(stock, "utf8");
if (!page.includes("<head>") || !page.includes("</body>")) throw new Error("unexpected ttyd page");
fs.writeFileSync(out, page
  .replace("<head>", "<head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
  .replace("</body>", () => "<script>" + fs.readFileSync(script, "utf8") + "</script></body>"));
' "$state/stock.html" "$root/mobile/page.js" "$state/index.html"
    exec env -u TMUX -u TMUX_PANE ttyd -i 127.0.0.1 -p "$port" -W -O -m 1 -t fontSize=14 \
      -I "$state/index.html" /bin/sh "$here/mobile-terminal.sh" attach "$session" ;;

  attach)
    # The installer's tmux server, else tmux's default. Never starts a server (-N): without the
    # session there is nothing to show.
    session=$2
    if [ -n "${PI_MOBILE_TMUX_SOCKET:-}" ]; then set -- -S "$PI_MOBILE_TMUX_SOCKET"; else set --; fi
    tmux "$@" has-session -t "=$session" || exit 1
    tmux "$@" source-file "$root/tmux/mobile.conf"
    # The sidebar resize hook that leaves Focus (a zoomed window) alone when the page resizes; from
    # run-shell, so its own tmux calls reach this server.
    tmux "$@" run-shell "sh '$here/tmux-sidebar.sh' - hook"
    exec tmux -N "$@" attach-session -t "=$session" ;;

  *) sed -n '2,6p' "$0" >&2; exit 2 ;;
esac
