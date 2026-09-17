#!/bin/sh
# Rebuild the Linux x86_64 binary the Pages workflow runs (bin/stockscan-
# static-x86_64-linux, committed so the workflow does not compile anything).
# Static musl build in Docker, from any host. Run after changing src/, then
# commit bin/.
set -eu
cd "$(dirname "$0")"
docker run --rm --platform linux/amd64 -v "$PWD":/w -w /w -e CARGO_TARGET_DIR=/w/target-linux rust:1-alpine \
  sh -c 'apk add --no-cache musl-dev gcc >/dev/null && cargo build --release --quiet'
mkdir -p bin
cp target-linux/release/stockscan-static bin/stockscan-static-x86_64-linux
chmod +x bin/stockscan-static-x86_64-linux
ls -la bin/stockscan-static-x86_64-linux
