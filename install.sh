#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/rbshah29/ggit.git"
MODE="auto" # auto | deb | user | uninstall

for arg in "$@"; do
    case "$arg" in
        --deb|--system) MODE="deb" ;;
        --user) MODE="user" ;;
        --uninstall) MODE="uninstall" ;;
        -h|--help)
            cat << 'EOF'
Usage: ./install.sh [OPTIONS]

Options:
  --deb, --system   Build and install the .deb package via apt (default on Debian/Ubuntu)
  --user            Install for the current user only (~/.local/bin/ggit)
  --uninstall       Remove ggit from the system and user directories
  -h, --help        Show this help message
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

if [ "$MODE" = "uninstall" ]; then
    if dpkg -s ggit >/dev/null 2>&1; then
        echo "Removing system package ggit via apt..."
        sudo apt-get remove -y ggit
    fi
    if [ -x "$HOME/.local/share/ggit/ggit.py" ]; then
        "$HOME/.local/share/ggit/ggit.py" --uninstall || true
    fi
    rm -rf "$HOME/.local/share/ggit" "$HOME/.local/bin/ggit"
    echo "ggit uninstalled."
    exit 0
fi

# Determine source directory (use local clone if running from repo, else clone to temp dir)
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    CANDIDATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$CANDIDATE/ggit.py" ] && [ -f "$CANDIDATE/desktop.py" ]; then
        SCRIPT_DIR="$CANDIDATE"
    fi
fi

TMP_DIR=""
cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT

if [ -z "$SCRIPT_DIR" ]; then
    echo "Downloading ggit from $REPO_URL..."
    TMP_DIR="$(mktemp -d)"
    git clone --depth 1 "$REPO_URL" "$TMP_DIR/ggit"
    SCRIPT_DIR="$TMP_DIR/ggit"
fi

if [ "$MODE" = "auto" ]; then
    if command -v dpkg-deb >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
        MODE="deb"
    else
        MODE="user"
    fi
fi

if [ "$MODE" = "deb" ]; then
    echo "Building .deb package..."
    bash "$SCRIPT_DIR/packaging/build-deb.sh"
    VERSION="$(python3 -c 'import sys; sys.path.insert(0, "'"$SCRIPT_DIR"'"); import ggit; print(ggit.VERSION)')"
    DEB_FILE="$SCRIPT_DIR/dist/ggit_${VERSION}_all.deb"
    echo "Installing $DEB_FILE via apt..."
    sudo apt-get update -qq || true
    sudo apt-get install -y "$DEB_FILE"
    echo ""
    echo "ggit installed! Run 'ggit' inside any git repository."
else
    INSTALL_DIR="$HOME/.local/share/ggit"
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR/static" "$BIN_DIR"
    install -m 0755 "$SCRIPT_DIR/ggit.py" "$INSTALL_DIR/ggit.py"
    install -m 0644 "$SCRIPT_DIR/desktop.py" "$INSTALL_DIR/desktop.py"
    install -m 0644 "$SCRIPT_DIR/static/"* "$INSTALL_DIR/static/"
    ln -sf "$INSTALL_DIR/ggit.py" "$BIN_DIR/ggit"
    "$INSTALL_DIR/ggit.py" --install || true
    echo ""
    echo "ggit installed to $BIN_DIR/ggit"
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) echo "Note: Add $BIN_DIR to your PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
fi
