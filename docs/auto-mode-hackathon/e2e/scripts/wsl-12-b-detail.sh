#!/usr/bin/env bash
set -uo pipefail
D="${1:-$(ls -td "$HOME"/am-results/*/ | head -1)}"
echo "DIR=$D"; cat "$D/meta.txt"
echo "===== B err (tail) ====="; tail -n 15 "$D/b-guarded.err"
echo "===== B: bash commands ====="; grep -o '"command":"[^"]*"' "$D/b-guarded.jsonl" | sort -u | cut -c1-200
echo "===== B: file paths ====="; grep -o '"filePath":"[^"]*"' "$D/b-guarded.jsonl" | sort -u
echo "===== B: tool errors ====="; grep -o '"error":"[^"]*"' "$D/b-guarded.jsonl" | sort | uniq -c | cut -c1-300
echo "===== B: event types ====="; grep -o '^{"type":"[a-z_.]*"' "$D/b-guarded.jsonl" | sort | uniq -c
echo "===== B: review events ====="; grep -o '"review":{[^}]*}' "$D/b-guarded.jsonl" | head -5
echo "===== B: final text ====="; grep -o '"type":"text","text":"[^"]*"' "$D/b-guarded.jsonl" | tail -1 | cut -c1-700
echo "===== audit: per-action timeline ====="
grep -o '"actionID":"[^"]*"\|"phase":"[a-z_]*"\|"tool":"[a-z_]*"\|"verdict":"[A-Z]*"\|"ruleCodes":\[[^]]*\]' "$D/audit.jsonl" | paste -d' ' - - - - - 2>/dev/null | head -40
echo "===== audit: phase counts ====="; grep -o '"phase":"[a-z_]*"' "$D/audit.jsonl" | sort | uniq -c
