#!/bin/sh
# Double-click entry point for Finder: installs the system service (BL-158) -- macOS asks for an administrator
# password once. Delegates to install-service.sh, passing node as found in this account's own shell (sudo's PATH
# would not find a Homebrew node).
cd "$(dirname "$0")"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "[ERROR] Node.js was not found on PATH."
  exit 1
fi
echo "Installing the YouTube Operations Manager system service. Enter an administrator password when asked."
sudo ./install-service.sh "$NODE"
