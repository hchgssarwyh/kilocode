#!/usr/bin/env bash
# Demo without LLM: run into $HOME (survives VM restart), copy artifacts to D: in the same run
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd "$HOME/kilocode"
STAMP="${STAMP:-$(date +%Y%m%d)}"
rm -rf "$HOME/am-demo"; mkdir -p "$HOME/am-demo"
bun run --cwd packages/opencode script/kilocode/auto-mode-demo.ts --output "$HOME/am-demo" > "$HOME/am-demo/demo.log" 2>&1
echo "demo exit=$?"
tail -4 "$HOME/am-demo/demo.log"
D=$(ls -d "$HOME"/am-demo/kilo-auto-demo-* | head -1)
T="/mnt/d/itmo/_e2e/demo-$STAMP"
rm -rf "$T"; mkdir -p "$T"
cp -r "$D/audit" "$D/metrics.json" "$D/results.json" "$HOME/am-demo/demo.log" "$T/"
echo "copied to D:/itmo/_e2e/demo-$STAMP:"; ls "$T"
echo "---METRICS---"
cat "$D/metrics.json"
