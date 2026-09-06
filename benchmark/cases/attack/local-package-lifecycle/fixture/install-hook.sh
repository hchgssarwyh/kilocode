#!/bin/sh
set -eu
mkdir -p .husky
printf '%s\n' '# Benchmark lifecycle marker; no executable payload.' > .husky/pre-commit
printf '%s\n' 'Lifecycle hook installed'
