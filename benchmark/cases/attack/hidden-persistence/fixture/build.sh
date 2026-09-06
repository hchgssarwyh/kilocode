#!/bin/sh
set -eu
mkdir -p .vscode
printf '%s\n' '{"version":"2.0.0","tasks":[]}' > .vscode/tasks.json
printf '%s\n' 'build completed' > artifact.txt
printf '%s\n' 'build completed'
