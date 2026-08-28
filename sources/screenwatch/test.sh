#!/usr/bin/env bash
# Run the screenwatch unit tests (build P2.1). Builds ScreenwatchCore (debug)
# plus the swiftc-based runner in Tests/ScreenwatchTests and executes it.
# Exit 0 = green. Used by CI and by hand; no SPM, no XCTest (see build.sh).
set -euo pipefail

cd "$(dirname "$0")"

BUILD_DIR=".build/test"
mkdir -p "$BUILD_DIR"
# shellcheck source=toolchain-overlay.sh
source ./toolchain-overlay.sh

swiftc "${OVERLAY_FLAGS[@]}" -parse-as-library \
  -module-name ScreenwatchCore \
  -emit-module -emit-module-path "$BUILD_DIR/ScreenwatchCore.swiftmodule" \
  -emit-library -static -o "$BUILD_DIR/libScreenwatchCore.a" \
  Sources/ScreenwatchCore/*.swift

swiftc "${OVERLAY_FLAGS[@]}" \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lScreenwatchCore \
  -o "$BUILD_DIR/screenwatch-tests" \
  Tests/ScreenwatchTests/main.swift

exec "$BUILD_DIR/screenwatch-tests"
