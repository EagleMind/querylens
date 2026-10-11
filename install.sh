#!/bin/sh
# Install the QueryLens CLI (macOS, Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/EagleMind/querylens/main/install.sh | sh
#
# Environment: QUERYLENS_VERSION (default: latest), QUERYLENS_INSTALL_DIR (default:
# ~/.querylens/bin).
set -eu

repo="EagleMind/querylens"
dir="${QUERYLENS_INSTALL_DIR:-$HOME/.querylens/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "querylens: unsupported OS $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "querylens: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

asset="querylens-$os-$arch.tar.gz"
if [ -n "${QUERYLENS_VERSION:-}" ]; then
  url="https://github.com/$repo/releases/download/v${QUERYLENS_VERSION#v}/$asset"
else
  url="https://github.com/$repo/releases/latest/download/$asset"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/querylens" "$dir/querylens"
chmod +x "$dir/querylens"

echo "Installed $("$dir/querylens" --version) to $dir/querylens"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$dir:\$PATH\"" ;;
esac
echo "Then, in your project:  querylens capture -- npm test"
