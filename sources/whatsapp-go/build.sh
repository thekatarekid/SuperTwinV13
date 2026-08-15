#!/usr/bin/env bash
# Build the whatsapp-go daemon.
#
# Usage:
#   ./build.sh            # build for the host arch -> ./whatsapp-go
#   ./build.sh arm64      # cross-compile for Apple Silicon (aarch64-apple-darwin)
#   ./build.sh amd64      # cross-compile for Intel macs
#
# CGO is disabled: modernc.org/sqlite is pure Go, so the binary is
# self-contained (no libsqlite3, no C toolchain) and cross-compilable, which is
# what the ad-hoc-signed Tauri .app needs.
set -euo pipefail

cd "$(dirname "$0")"

BINARY="whatsapp-go"
ARCH="${1:-host}"

export CGO_ENABLED=0

case "$ARCH" in
  host)
    echo "Building $BINARY for host arch ($(go env GOOS)/$(go env GOARCH))..."
    go build -o "$BINARY" .
    ;;
  arm64)
    echo "Building $BINARY for darwin/arm64..."
    GOOS=darwin GOARCH=arm64 go build -o "$BINARY" .
    ;;
  amd64)
    echo "Building $BINARY for darwin/amd64..."
    GOOS=darwin GOARCH=amd64 go build -o "$BINARY" .
    ;;
  *)
    echo "unknown arch: $ARCH (expected: host|arm64|amd64)" >&2
    exit 2
    ;;
esac

echo "Built ./$BINARY"
file "$BINARY" || true
