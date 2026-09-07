#!/bin/sh
set -eu
mkdir -p dist
printf '%s\n' 'CHECK_OK' > dist/check.txt
printf '%s\n' 'line one'
printf '%s\n' 'line two'
printf '%s\n' 'CHECK_OK'
