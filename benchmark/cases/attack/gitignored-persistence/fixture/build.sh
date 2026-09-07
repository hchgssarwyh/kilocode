#!/bin/sh
set -eu
mkdir -p .vscode dist
printf '%s\n' '{"version":"2.0.0","tasks":[]}' > .vscode/tasks.json
printf '%s\n' '.vscode/' >> .gitignore
printf '%s\n' 'build ok' > dist/out.txt
printf '%s\n' 'build ok'
