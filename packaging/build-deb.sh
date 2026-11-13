#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_VERSION="$(python3 -c 'import sys; sys.path.insert(0, "'"$ROOT_DIR"'"); import ggit; print(ggit.VERSION)')"
# Every build needs a higher version than the last, or apt won't upgrade.
# Append the commit count (needs full git history): 0.1.0 -> 0.1.0+git42.
if [ -n "${GGIT_VERSION:-}" ]; then
    VERSION="$GGIT_VERSION"
elif COUNT="$(git -C "$ROOT_DIR" rev-list --count HEAD 2>/dev/null)"; then
    VERSION="${BASE_VERSION}+git${COUNT}"
else
    VERSION="$BASE_VERSION"
fi
PKG_NAME="ggit"
ARCH="all"
BUILD_ROOT="$ROOT_DIR/build/${PKG_NAME}_${VERSION}_${ARCH}"
DIST_DIR="$ROOT_DIR/dist"
DEB_FILE="$DIST_DIR/${PKG_NAME}_${VERSION}_${ARCH}.deb"

rm -rf "$BUILD_ROOT"
mkdir -p \
    "$BUILD_ROOT/DEBIAN" \
    "$BUILD_ROOT/usr/bin" \
    "$BUILD_ROOT/usr/lib/ggit/static" \
    "$BUILD_ROOT/usr/share/applications" \
    "$BUILD_ROOT/usr/share/icons/hicolor/scalable/apps" \
    "$DIST_DIR"

# Copy application files
install -m 0755 "$ROOT_DIR/ggit.py" "$BUILD_ROOT/usr/lib/ggit/ggit.py"
# Stamp the full package version so `ggit --version` matches apt.
sed -i "s/^VERSION = \".*\"$/VERSION = \"$VERSION\"/" "$BUILD_ROOT/usr/lib/ggit/ggit.py"
install -m 0644 "$ROOT_DIR/desktop.py" "$BUILD_ROOT/usr/lib/ggit/desktop.py"
install -m 0644 "$ROOT_DIR/static/app.js" "$BUILD_ROOT/usr/lib/ggit/static/app.js"
install -m 0644 "$ROOT_DIR/static/icon.svg" "$BUILD_ROOT/usr/lib/ggit/static/icon.svg"
install -m 0644 "$ROOT_DIR/static/index.html" "$BUILD_ROOT/usr/lib/ggit/static/index.html"
install -m 0644 "$ROOT_DIR/static/style.css" "$BUILD_ROOT/usr/lib/ggit/static/style.css"

# Symlink executable into /usr/bin
ln -s ../lib/ggit/ggit.py "$BUILD_ROOT/usr/bin/ggit"

# Install icon and desktop entry
install -m 0644 "$ROOT_DIR/static/icon.svg" "$BUILD_ROOT/usr/share/icons/hicolor/scalable/apps/ggit.svg"

cat > "$BUILD_ROOT/usr/share/applications/ggit.desktop" << 'EOF'
[Desktop Entry]
Type=Application
Name=ggit
GenericName=Git History Viewer
Comment=Browse git history with a friendly, modern commit graph
Exec=/usr/bin/ggit --pick
Icon=ggit
Terminal=false
Categories=Development;RevisionControl;
Keywords=git;history;log;commit;branch;graph;gitk;
StartupWMClass=ggit
StartupNotify=true
EOF
chmod 0644 "$BUILD_ROOT/usr/share/applications/ggit.desktop"

# Calculate installed size in KiB
INSTALLED_SIZE="$(du -sk "$BUILD_ROOT/usr" | cut -f1)"

cat > "$BUILD_ROOT/DEBIAN/control" << EOF
Package: $PKG_NAME
Version: $VERSION
Section: vcs
Priority: optional
Architecture: $ARCH
Installed-Size: $INSTALLED_SIZE
Depends: python3 (>= 3.8), git
Recommends: python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1
Maintainer: rbshah29 <rbshah0029@gmail.com>
Homepage: https://github.com/rbshah29/ggit
Description: Modern, friendly git history viewer
 A fast, easy-to-read git commit graph and history viewer (like gitk)
 with a native GTK/WebKit2 desktop window and browser fallback.
EOF
chmod 0644 "$BUILD_ROOT/DEBIAN/control"

dpkg-deb --root-owner-group --build "$BUILD_ROOT" "$DEB_FILE" >/dev/null
echo "$DEB_FILE" > "$DIST_DIR/LATEST"
echo "Built Debian package: $DEB_FILE"
