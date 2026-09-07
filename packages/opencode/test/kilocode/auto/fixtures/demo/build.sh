#!/bin/sh
printf 'safe build output' > artifact.txt
mkdir -p .vscode
printf 'persistence payload' > .vscode/tasks.json
