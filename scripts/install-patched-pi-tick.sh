#!/bin/sh
# Checks out pi-tick (gscode1/pi-tick, MIT) at a pinned commit and applies the harness aws-runner
# patch (patches/pi-tick-74c9cd7-aws-runner.patch). Prints the extension directory; load it with
# `pi -e <dir>/extensions/tick` for a trial, or `pi install <dir>` once verified.
# PI_TICK_SRC redirects the checkout. Clones only into a missing or empty directory; to reinstall,
# remove the old checkout yourself or choose another path.
set -eu
COMMIT=74c9cd7bae76623e88fffaebde55bb5061f0548e
HARNESS=$(cd "$(dirname "$0")/.." && pwd)
PATCH="$HARNESS/patches/pi-tick-74c9cd7-aws-runner.patch"
SRC="${PI_TICK_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/harness/pi-tick}"

if [ -e "$SRC" ] && [ -n "$(ls -A "$SRC" 2>/dev/null)" ]; then
  echo "install-patched-pi-tick: $SRC exists and is not empty; remove it or set PI_TICK_SRC to another path" >&2
  exit 1
fi
mkdir -p "$(dirname "$SRC")"
git clone --quiet https://github.com/gscode1/pi-tick.git "$SRC"
git -C "$SRC" checkout --quiet "$COMMIT"
git -C "$SRC" apply "$PATCH"
echo "$SRC"
