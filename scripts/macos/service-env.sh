# YouTube Operations Manager - macOS system service (BL-158): the names every script shares. Sourced, not run.
# The service is a launchd daemon running as the owner's account: it starts when the Mac is switched on (with FileVault,
# once anyone unlocks it), so a second Mac account can use http://localhost:3000 without the owner being logged in.
SERVICE_LABEL="local.ytom.server"
SERVICE_PLIST="/Library/LaunchDaemons/$SERVICE_LABEL.plist"

# True (exit 0) when the service is installed on this Mac.
service_installed() {
  [ -f "$SERVICE_PLIST" ]
}
