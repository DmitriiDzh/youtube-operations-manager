import { hasProxyHeaders, isRemoteRequest } from "@/lib/loopback-guard";

export { hasProxyHeaders, isRemoteRequest };

/** The request's own origin as the browser on the phone sees it (scheme from the proxy, host from X-Forwarded-Host / Host). */
export function ownOrigin(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  const proto = (headers.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
  return `${proto}://${host.split(",")[0].trim()}`.toLowerCase();
}

/** CSRF (the network-exposure gate): a mutating remote request must come from a page of this same origin. */
export function isSameOriginMutation(headers: Headers): boolean {
  const origin = headers.get("origin");
  const own = ownOrigin(headers);
  return origin !== null && own !== null && origin.toLowerCase() === own;
}
