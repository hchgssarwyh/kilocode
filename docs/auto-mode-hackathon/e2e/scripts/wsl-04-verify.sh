#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$HOME/kilocode"
echo "===== DEMO ====="
bun run --cwd packages/opencode script/kilocode/auto-mode-demo.ts --output /tmp
echo "===== demo exit: $? ====="
echo "===== TESTS ====="
cd packages/opencode
bun test ./test/kilocode/auto/
echo "===== tests exit: $? ====="
