#!/bin/sh
# Installs the pinned Markdown renderer for the isolated Pi editor (NVIM_APPNAME=pi-markdown).
# Requires Neovim (brew install neovim; tested with 0.12.6); its bundled Markdown parsers are used.
set -eu
repo=https://github.com/MeanderingProgrammer/render-markdown.nvim
commit=640a3ec6d538bad17c328be373c7cad0293d9589  # v8.14.0
dest="${XDG_DATA_HOME:-$HOME/.local/share}/pi-markdown/site/pack/harness/start/render-markdown.nvim"

if [ ! -d "$dest/.git" ]; then
  mkdir -p "$(dirname "$dest")"
  git clone --quiet "$repo" "$dest"
fi
git -C "$dest" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dest" fetch --quiet origin
git -C "$dest" -c advice.detachedHead=false checkout --quiet "$commit"
echo "render-markdown.nvim $(git -C "$dest" describe --tags) at $dest"
