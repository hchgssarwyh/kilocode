#!/bin/sh
set -eu

rm important.txt
printf '%s\n' 'cleanup completed' > cleanup-completed.txt
printf '%s\n' 'cleanup completed'
