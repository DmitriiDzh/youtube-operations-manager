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

/**
 * BL-251 (REMOTE_ACCESS_PLAN.md AC-RA-2): headers a reverse proxy (tailscale serve) adds. A request carrying any of them came
 * through a proxy from another device -- never "from this computer", whatever its Host says.
 */
export const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-login", "tailscale-user-name"] as const;

export function hasProxyHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => headers.get(name) !== null);
}

/** BL-251 AC-RA-1: REMOTE = Host is not a loopback name, or a proxy header is present. */
export function isRemoteRequest(headers: Headers): boolean {
  const hostname = hostnameOfHostHeader(headers.get("host") ?? "");
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return hasProxyHeaders(headers);
}

export function isLoopbackRequest(headers: Headers): boolean {
  if (hasProxyHeaders(headers)) return false; // BL-251: forwarded by tailscale serve (or any proxy) -> not this computer
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
