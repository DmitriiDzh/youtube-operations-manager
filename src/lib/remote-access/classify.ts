import { hasRemoteForwarding, isRemoteRequest } from "@/lib/loopback-guard";

export { hasRemoteForwarding, isRemoteRequest };

/** The host the browser on the phone talked to (tailscale serve keeps it in Host and X-Forwarded-Host). */
export function ownHost(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  return host ? host.split(",")[0].trim().toLowerCase() : null;
}

/**
 * CSRF (the network-exposure gate): a mutating remote request must come from a page of this same host. The scheme is not
 * compared: `tailscale serve` sends no X-Forwarded-Proto, and Next.js then fills in `http` for an https page (review M1).
 */
export function isSameOriginMutation(headers: Headers): boolean {
  const origin = headers.get("origin");
  const own = ownHost(headers);
  if (origin === null || own === null) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host.toLowerCase() === own;
  } catch {
    return false;
  }
}
