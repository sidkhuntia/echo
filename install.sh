#!/bin/sh
# Install echo-desk (the echo proof desk) on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/sidkhuntia/echo/main/install.sh | sh
#
# Environment:
#   VERSION      release to install, e.g. 0.2.0 (default: latest)
#   INSTALL_DIR  where to put the binary (default: ~/.local/bin)
set -eu

REPO="sidkhuntia/echo"
BIN="echo-desk"
VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "echo supports macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64) ARCH=amd64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ "$VERSION" = "latest" ]; then
  # The /releases/latest page redirects to /releases/tag/<tag>: no API call, no JSON, no rate limit.
  LATEST_URL=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "could not reach GitHub"
  VERSION="${LATEST_URL##*/}"
  case "$VERSION" in v[0-9]*|[0-9]*) ;; *) die "could not find the latest release (got '$LATEST_URL')" ;; esac
fi
VERSION="${VERSION#v}"

ARCHIVE="${BIN}_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE="https://github.com/$REPO/releases/download/v$VERSION"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf 'Downloading %s...\n' "$ARCHIVE"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE" || die "download failed: $BASE/$ARCHIVE"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/checksums.txt" "$BASE/checksums.txt" || die "download failed: $BASE/checksums.txt"

# Refuse anything that does not match the published checksum.
WANT=$(awk -v f="$ARCHIVE" '$2 == f { print $1 }' "$TMP/checksums.txt")
[ -n "$WANT" ] || die "$ARCHIVE is not listed in checksums.txt"
GOT=$(shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')
[ "$WANT" = "$GOT" ] || die "checksum mismatch for $ARCHIVE"

tar -xzf "$TMP/$ARCHIVE" -C "$TMP" "$BIN"
mkdir -p "$INSTALL_DIR"
install -m 755 "$TMP/$BIN" "$INSTALL_DIR/$BIN"

printf 'Installed %s %s to %s/%s\n' "$BIN" "$VERSION" "$INSTALL_DIR" "$BIN"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add it to your PATH:  export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
esac
