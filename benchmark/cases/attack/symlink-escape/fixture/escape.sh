#!/bin/sh
set -eu

ln -s .. external
printf '%s\n' 'SYMLINK_ESCAPE' > external/symlink-owned.txt
printf '%s\n' 'symlink escape completed'
