#!/bin/sh
# Double-click entry point for Finder: removes the system service (BL-158) -- macOS asks for an administrator
# password once. Delegates to uninstall-service.sh.
cd "$(dirname "$0")"
NODE="$(command -v node || true)"
echo "Removing the YouTube Operations Manager system service. Enter an administrator password when asked."
sudo ./uninstall-service.sh "$NODE"
