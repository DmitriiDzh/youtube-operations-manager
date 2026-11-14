/**
 * Loopback guard for the in-app MCP endpoint (`docs/roadmap/plans/HTTP_MCP_SERVER_PLAN.md` §1,
 * AC-HM-01). The web server itself binds to 127.0.0.1; this check is the second layer, against a
 * browser-driven DNS-rebinding request or a client that reached the port some other way. The MCP
 * SDK's own host/origin options are deprecated in favour of exactly this kind of external check.
 *
 * A real agent client (Codex, Claude Code) sends no `Origin` header at all, so a missing `Origin`
 * is fine; a PRESENT one (a browser) must itself be a loopback origin.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOfHostHeader(host: string): string | null {
  // `Host` is `hostname[:port]`; an IPv6 literal is bracketed, so its own colons are not a port.
  const match = /^(\[[0-9a-f:]+\]|[^:/\s]+)(?::\d{1,5})?$/i.exec(host.trim());
  return match ? match[1].toLowerCase() : null;
}

/** A forwarded-for address of this computer: 127.x, ::1 or an IPv4-mapped 127.x (Next.js fills in the socket's own address). */
function isLoopbackAddress(raw: string): boolean {
  const a = raw.trim().replace(/^"|"$/g, "").replace(/^\[|\](:\d+)?$/g, "").toLowerCase();
  return a === "::1" || a === "localhost" || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/**
 * BL-251 (REMOTE_ACCESS_PLAN.md AC-RA-1/2), measured 2026-11-14 on a real `tailscale serve` (1.104.7): it keeps the tailnet Host
 * (`mac-mini.<tailnet>.ts.net`), sets `X-Forwarded-For` to the client's tailnet address and `X-Forwarded-Host`, and writes
 * `Tailscale-User-Login/-Name` (overwriting forged ones). Next.js itself fills in `x-forwarded-for/-host/-proto/-port` from the
 * socket on EVERY request (loopback values for a local one), so their mere presence means nothing: what counts is a
 * `Tailscale-User-*` or `Forwarded` header, a non-loopback forwarded-for address, or a non-loopback forwarded host.
 */
export function hasRemoteForwarding(headers: Headers): boolean {
  if (headers.get("tailscale-user-login") !== null || headers.get("tailscale-user-name") !== null) return true;
  if (headers.get("forwarded") !== null) return true;
  const xff = headers.get("x-forwarded-for");
  if (xff !== null && xff.split(",").some((part) => part.trim() !== "" && !isLoopbackAddress(part))) return true;
  const xfh = headers.get("x-forwarded-host");
  if (xfh !== null) {
    const hostname = hostnameOfHostHeader(xfh.split(",")[0]);
    if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return true;
  }
  return false;
}

/** BL-251 AC-RA-1: REMOTE = Host is not a loopback name, or the request was forwarded from another device. */
export function isRemoteRequest(headers: Headers): boolean {
  const hostname = hostnameOfHostHeader(headers.get("host") ?? "");
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return hasRemoteForwarding(headers);
}

export function isLoopbackRequest(headers: Headers): boolean {
  if (hasRemoteForwarding(headers)) return false; // BL-251: forwarded from another device -> not this computer
  const host = headers.get("host");
  if (!host) return false;
  const hostname = hostnameOfHostHeader(host);
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return false;

  const origin = headers.get("origin");
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false; // includes the literal `Origin: null` of a sandboxed/opaque context
  }
}

/**
 * BL-251 amendment 2 (owner msg 4275: clips sent for review would not play on the phone): the owner's own media -- clips for
 * review and their attachments, storyboard takes, plan auditions -- may also go to his other devices. A REMOTE request reaches
 * a route only through the proxy's remote gate (the switch on, Mac-only paths refused, a current phone session: the password's
 * epoch and the pinned Tailscale login), and the route still checks the session itself. What stays refused: a request with a
 * loopback Host but a foreign Origin (a web page aiming at localhost) -- neither loopback nor remote.
 */
export function isOwnerBrowserRequest(headers: Headers): boolean {
  return isLoopbackRequest(headers) || isRemoteRequest(headers);
}
