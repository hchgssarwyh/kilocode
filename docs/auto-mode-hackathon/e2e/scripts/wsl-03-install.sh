#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$HOME/kilocode"
bun install
echo "install exit=$?"
test -d packages/opencode/node_modules/effect && echo EFFECT_OK || echo EFFECT_MISSING
