#!/usr/bin/env bash
# Build the screenwatch sidecar (build P2.1) — same interface as
# sources/whatsapp-go/build.sh:
#
#   ./build.sh            # build for the host arch -> ./screenwatch
#   ./build.sh arm64      # Apple Silicon
#   ./build.sh amd64      # Intel macs
#
# Plain swiftc, not SPM: the sidecar has zero package dependencies, and a
# bare CommandLineTools install (no Xcode, broken SPM manifest toolchain)
# can build it. Two steps: ScreenwatchCore as a static module, then the
# executable linked against it. ./test.sh reuses the same module.
set -euo pipefail

cd "$(dirname "$0")"

BINARY="screenwatch"
ARCH="${1:-host}"
BUILD_DIR=".build"

TARGET_FLAGS=()
case "$ARCH" in
  host) ;;
  arm64) TARGET_FLAGS=(-target arm64-apple-macosx13.0) ;;
  amd64) TARGET_FLAGS=(-target x86_64-apple-macosx13.0) ;;
  *)
    echo "unknown arch: $ARCH (expected: host|arm64|amd64)" >&2
    exit 2
    ;;
esac

mkdir -p "$BUILD_DIR"
# shellcheck source=toolchain-overlay.sh
source ./toolchain-overlay.sh

echo "Building ScreenwatchCore..."
swiftc ${TARGET_FLAGS[@]+"${TARGET_FLAGS[@]}"} "${OVERLAY_FLAGS[@]}" \
  -O -parse-as-library \
  -module-name ScreenwatchCore \
  -emit-module -emit-module-path "$BUILD_DIR/ScreenwatchCore.swiftmodule" \
  -emit-library -static -o "$BUILD_DIR/libScreenwatchCore.a" \
  Sources/ScreenwatchCore/*.swift

echo "Building $BINARY..."
swiftc ${TARGET_FLAGS[@]+"${TARGET_FLAGS[@]}"} "${OVERLAY_FLAGS[@]}" \
  -O \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lScreenwatchCore \
  -o "$BINARY" \
  Sources/screenwatch/*.swift

chmod 755 "$BINARY"
echo "Built ./$BINARY"
file "$BINARY" || true
