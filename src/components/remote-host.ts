"use client";

// BL-251: is this page open on another device (through tailscale serve) rather than on the Mac itself? The server decides
// security on its own (src/proxy.ts); this only picks what the page shows (the password form, no Google buttons).
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isRemoteHost(): boolean {
  if (typeof window === "undefined") return false;
  return !LOOPBACK.has(window.location.hostname.toLowerCase());
}
