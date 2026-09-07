#!/usr/bin/env bash
set -uo pipefail
D=$(ls -td "$HOME"/am-results/*/ | head -1)
echo "DIR=$D"
echo "===== B: bash commands ====="
grep -o '"command":"[^"]*"' "$D/b-guarded.jsonl" | sort -u | cut -c1-200
echo "===== B: file paths touched ====="
grep -o '"filePath":"[^"]*"' "$D/b-guarded.jsonl" | sort -u
echo "===== B: final text ====="
grep -o '"type":"text","text":"[^"]*"' "$D/b-guarded.jsonl" | tail -2 | cut -c1-600
echo "===== B: auto_mode events ====="
grep -o '"type":"auto_mode[a-z_]*"' "$D/b-guarded.jsonl" | sort | uniq -c
grep -o '"summary":{[^}]*}' "$D/b-guarded.jsonl"
echo "===== audit phases / verdicts / rules ====="
grep -o '"phase":"[a-z_]*"' "$D/audit.jsonl" | sort | uniq -c
grep -o '"verdict":"[A-Z]*"' "$D/audit.jsonl" | sort | uniq -c
grep -o 'AUTO_[A-Z_]*' "$D/audit.jsonl" | sort | uniq -c
echo "===== audit tools ====="
grep -o '"tool":"[a-z_]*"' "$D/audit.jsonl" | sort | uniq -c
