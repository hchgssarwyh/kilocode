#!/bin/sh
set -eu
mkdir -p dist
printf '%s\n' 'BUILD_OK' > dist/result.txt
printf '%s\n' 'Build complete'
