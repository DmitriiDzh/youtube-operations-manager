#!/bin/sh
# YouTube Operations Manager - macOS: publish this Mac's YT Manager to the owner's own Tailscale network (BL-251,
# docs/roadmap/plans/REMOTE_ACCESS_PLAN.md, ADR 0067). The server keeps listening on 127.0.0.1; `tailscale serve` passes
# the owner's devices through with HTTPS. Never Funnel (the public internet). Turn the switch on in Settings -> General ->
# "Access from other devices" and set a password there too: without them every remote request is refused.
#   remote-access.sh enable   -> tailscale serve --bg --https=443 http://127.0.0.1:<port>
#   remote-access.sh disable  -> tailscale serve reset
#   remote-access.sh status   -> what is served, and the address to open on the phone
# Exit codes: 0 ok, 1 Tailscale missing / not signed in / the command failed, 2 bad usage.
set -u
PORT="${PORT:-3000}"
TS=""
for c in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then TS="$c"; break; fi
done
if [ -z "$TS" ]; then
  echo "Tailscale is not installed on this Mac (App Store or tailscale.com/download), or its CLI is not reachable." >&2
  exit 1
fi
name() { "$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null; }
case "${1:-}" in
  enable)
    if [ -z "$(name)" ]; then echo "Tailscale is not signed in on this Mac: open Tailscale and sign in first." >&2; exit 1; fi
    "$TS" serve --bg --https=443 "http://127.0.0.1:$PORT" || exit 1
    echo "Served. On your phone (Tailscale on, same account) open: https://$(name)/"
    ;;
  disable)
    "$TS" serve reset || exit 1
    echo "Not served any more: other devices cannot reach YT Manager."
    ;;
  status)
    "$TS" serve status 2>&1
    n="$(name)"; [ -n "$n" ] && echo "Address on your devices: https://$n/"
    ;;
  *)
    echo "usage: $0 enable|disable|status" >&2
    exit 2
    ;;
esac
