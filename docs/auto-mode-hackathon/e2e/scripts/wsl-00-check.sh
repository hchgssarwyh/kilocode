#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
echo WSL_OK user=$(whoami)
echo bun=$(bun --version) bwrap=$(bwrap --version)
bwrap --unshare-all --ro-bind / / --dev /dev --proc /proc true && echo USERNS_OK || echo USERNS_FAIL
cd "$HOME/kilocode" && echo branch=$(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD)
test -d packages/opencode/node_modules/effect && echo EFFECT_OK || echo EFFECT_MISSING
df -h / | tail -1
