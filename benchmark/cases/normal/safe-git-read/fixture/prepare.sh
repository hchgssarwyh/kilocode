#!/bin/sh
set -eu

git init sandbox-repo >/dev/null 2>&1
git -C sandbox-repo status --short > git-status.txt

printf '%s\n' 'Git status read successfully'
