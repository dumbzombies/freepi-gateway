#!/usr/bin/env bash
# freepi-proxy one-shot installer for Linux, macOS and Termux.
#
#   curl -fsSL https://raw.githubusercontent.com/therealfreddied/freepi-proxy/main/install.sh | bash
#
# Installs into ${FREEPI_HOME:-$XDG_DATA_HOME/freepi-proxy} and puts a
# `freepi-proxy` launcher on your PATH (${FREEPI_BIN:-$HOME/.local/bin}).
# Requires: bash, curl (or wget), tar, and Node.js >= 22.19 or Bun.
set -euo pipefail

REPO="therealfreddied/freepi-proxy"
BRANCH="${FREEPI_BRANCH:-main}"
DEST="${FREEPI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/freepi-proxy}"
BIN="${FREEPI_BIN:-$HOME/.local/bin}"
TARBALL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"

die() { echo "install: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

ver_ge() { # ver_ge HAVE MIN -- portable, no sort -V (macOS lacks it)
  local IFS=.
  local -a a=($1) b=($2)
  local i x y
  for i in 0 1 2; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    ((10#$x > 10#$y)) && return 0
    ((10#$x < 10#$y)) && return 1
  done
  return 0
}

have_runtime() {
  if need node; then
    local v
    v="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
    # Node >= 22.19 runs TypeScript directly (type stripping on by default).
    if ver_ge "$v" "22.19.0"; then return 0; fi
    echo "install: Node $v is older than 22.19" >&2
  fi
  need bun && return 0
  return 1
}

need tar || die "tar is required"
need curl || need wget || die "curl or wget is required"

if ! have_runtime; then
  cat >&2 <<'EOF'
install: no supported runtime found.

Install one of these first, then re-run:
  Node.js >= 22.19   https://nodejs.org
  Bun                curl -fsSL https://bun.sh/install | bash
EOF
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading ${REPO}@${BRANCH}…"
if need curl; then
  curl -fsSL "$TARBALL" | tar -xz -C "$tmp"
else
  wget -qO- "$TARBALL" | tar -xz -C "$tmp"
fi

src="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
[ -d "$src/src" ] || die "unexpected archive layout"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$src" "$DEST"
chmod +x "$DEST/freepi-proxy"

mkdir -p "$BIN"
ln -sf "$DEST/freepi-proxy" "$BIN/freepi-proxy"

echo
echo "installed  $DEST"
echo "launcher   $BIN/freepi-proxy"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: add $BIN to PATH, e.g.  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo
echo "next:"
echo "  freepi-proxy start -d     # background proxy on port ${FREEPI_PROXY_PORT:-8452}"
echo "  freepi-proxy open         # dashboard → log in, then use /v1"
