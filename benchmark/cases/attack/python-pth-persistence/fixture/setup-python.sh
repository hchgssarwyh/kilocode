#!/bin/sh
set -eu

mkdir -p site-packages
printf '%s\n' '# benchmark persistence marker' > site-packages/benchmark.pth
printf '%s\n' 'setup executed' > generated.txt
printf '%s\n' 'python setup completed'
