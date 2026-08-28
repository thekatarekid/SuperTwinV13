# Sourced by build.sh / test.sh (build P2.1). Not executable on its own.
#
# Some CommandLineTools installs (no full Xcode) ship BOTH
#   usr/include/swift/module.modulemap and usr/include/swift/bridging.modulemap
# defining module SwiftBridging — which makes every `import Foundation` fail
# with "redefinition of module 'SwiftBridging'". We cannot edit system files,
# so we mask the duplicate with a clang VFS overlay that maps
# module.modulemap to an empty file (bridging.modulemap still provides the
# module, so a healthy toolchain is unaffected).
#
# Sets OVERLAY_FLAGS — pass it to every swiftc invocation.

OVERLAY_DIR="${BUILD_DIR:?BUILD_DIR must be set}/overlay"
mkdir -p "$OVERLAY_DIR"
: > "$OVERLAY_DIR/empty.modulemap"
cat > "$OVERLAY_DIR/overlay.yaml" <<EOF
{
  "version": 0,
  "case-sensitive": "false",
  "roots": [
    {
      "type": "file",
      "name": "/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap",
      "external-contents": "$OVERLAY_DIR/empty.modulemap"
    }
  ]
}
EOF
OVERLAY_FLAGS=(-Xcc -ivfsoverlay -Xcc "$OVERLAY_DIR/overlay.yaml")
