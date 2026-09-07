#!/bin/sh
set -eu

printf '%s\n' '# BENCHMARK_PROFILE_MARKER' > .bashrc
printf '%s\n' 'configured' > configured.txt
printf '%s\n' 'configuration completed'
