import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// AC-CONN-07/08/09 (docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md): SSRF /
// internal-network-access protection for user-configurable Base URLs.
//
// Two layers, both required:
//  1. Protocol check -- HTTPS required unless `allowLocal` (local-inference mode) is
//     explicitly on for this connection.
//  2. Address check -- the hostname is resolved (or, if it's already an IP literal,
//     used directly) and checked against private/loopback/link-local/reserved/
//     multicast ranges (including the cloud-metadata address 169.254.169.254) unless
//     `allowLocal` is on.
//
// This is called immediately before every real outbound generation/test call
// (src/lib/ai-connections/adapters/openai-compatible.ts's `callOnce`) -- the
// authoritative enforcement point required by INV-AIC-3. It is currently NOT also
// called at save time (createConnection/updateConnection persist the Base URL
// as-is); that "early feedback at save" a past revision of this comment claimed
// does not exist in the implementation. INV-AIC-3 only requires validation before
// each real call, which this satisfies, but a operator only discovers a
// misconfigured/blocked Base URL at first generate/test time rather than at save
// time -- a UX gap, not a safety gap, worth revisiting if this UI is ever exposed
// to a less trusted operator. It intentionally does NOT pin the outbound
// HTTP request to the exact address validated here -- doing so would require a custom
// fetch dispatcher/agent, which this MVP does not build. This leaves a narrow
// DNS-rebinding TOCTOU window between validation and the actual request, documented
// as a residual limitation (docs/TECHNICAL_DEBT.md) acceptable for the current
// single-operator, locally-trusted deployment model (AGENTS.md's Gate D boundary).
// ---------------------------------------------------------------------------

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

// AC-CONN-12 bounds the *outbound HTTP call* to a timeout, but that call's own
// AbortController is only created after `validateEndpointUrl` (and thus this DNS
// lookup) has already resolved -- an unresponsive/hanging resolver would otherwise
// block the whole request pipeline indefinitely with no bound of its own, and tie up
// a Node DNS-threadpool slot while doing so. This gives the resolution phase its own,
// independent timeout so a stuck resolver fails closed instead of hanging forever.
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

/** Exported only so the test suite can exercise the timeout path in milliseconds
 * instead of waiting out the real production timeout. Not part of the public API
 * used by production callers. */
export async function raceDnsLookupAgainstTimeout(
  lookupPromise: Promise<Array<{ address: string; family: number }>>,
  hostname: string,
  timeoutMs: number
): Promise<Array<{ address: string; family: number }>> {
  return await Promise.race([
    lookupPromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new DomainError({ code: "endpoint_not_allowed", message: "Base URL hostname lookup timed out", details: { hostname } })),
        timeoutMs
      );
      timer.unref?.();
    }),
  ]);
}

async function defaultDnsLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return await raceDnsLookupAgainstTimeout(dnsLookup(hostname, { all: true }), hostname, DNS_LOOKUP_TIMEOUT_MS);
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isInIpv4Range(ip: string, cidrBase: string, prefixLength: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(cidrBase);
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, INCLUDES the 169.254.169.254 cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => isInIpv4Range(ip, base, prefix));
}

// An embedded-IPv4 suffix can arrive as a dotted quad ("169.254.169.254", the form Node's own
// DNS resolver tends to use for these prefixes) or as two hex groups ("a9fe:a9fe", the form the
// WHATWG URL parser normalizes an IPv6 literal to -- `new URL("http://[64:ff9b::169.254.169.254]/")`
// itself rewrites the hostname to "[64:ff9b::a9fe:a9fe]" before this function ever sees it). Both
// must be recognized, or a literal URL's embedded address silently bypasses the unwrap.
function unwrapEmbeddedIpv4(suffix: string): string | null {
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const [hi, lo] = groups.map((g) => parseInt(g, 16));
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // link-local fe80::/10
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 (RFC 4291 §2.5.5.2) -- unwrap and re-check as IPv4.
    const mapped = unwrapEmbeddedIpv4(normalized.slice("::ffff:".length));
    return mapped ? isBlockedIpv4(mapped) : true; // unparseable mapped address -> block conservatively
  }
  if (normalized.startsWith("64:ff9b::")) {
    // NAT64 well-known prefix (RFC 6052 §2.1) -- also embeds an IPv4 address, in the low 32
    // bits, and must be unwrapped the same way or a synthesized address (e.g. a NAT64 gateway
    // resolving straight through to 169.254.169.254) would fall through to `false` below.
    const mapped = unwrapEmbeddedIpv4(normalized.slice("64:ff9b::".length));
    return mapped ? isBlockedIpv4(mapped) : true; // unparseable mapped address -> block conservatively
  }
  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true; // unknown family -> block conservatively
}

export async function validateEndpointUrl(
  rawUrl: string,
  options: { allowLocal: boolean; dnsLookup?: DnsLookupFn }
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DomainError({ code: "endpoint_not_allowed", message: "Base URL is not a valid URL", details: { rawUrl } });
  }

  if (!options.allowLocal && parsed.protocol !== "https:") {
    throw new DomainError({
      code: "endpoint_not_allowed",
      message: "Remote endpoints must use HTTPS unless local-inference mode is explicitly enabled for this connection",
      details: { protocol: parsed.protocol },
    });
  }
  if (options.allowLocal && !["https:", "http:"].includes(parsed.protocol)) {
    throw new DomainError({ code: "endpoint_not_allowed", message: "Unsupported URL protocol", details: { protocol: parsed.protocol } });
  }

  const hostname = parsed.hostname;
  // `URL#hostname` brackets an IPv6 literal (e.g. "[::1]"), but `net.isIP` only
  // recognizes the bare address -- without stripping the brackets here, EVERY IPv6
  // literal falls through to the DNS-lookup branch below instead of being checked
  // directly, silently defeating the "already an IP literal, check it directly"
  // fast path for the whole address family and making the block decision depend on
  // the (undocumented) fact that Node's `dns.lookup` happens to tolerate bracketed
  // input. Stripping the brackets makes the direct-IP path actually fire for IPv6.
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ipFamily = isIP(unbracketedHostname);

  const addressesToCheck: Array<{ address: string; family: number }> =
    ipFamily !== 0
      ? [{ address: unbracketedHostname, family: ipFamily }]
      : await (options.dnsLookup ?? defaultDnsLookup)(hostname);

  if (addressesToCheck.length === 0) {
    throw new DomainError({ code: "endpoint_not_allowed", message: "Base URL hostname did not resolve to any address", details: { hostname } });
  }

  if (!options.allowLocal) {
    const blocked = addressesToCheck.find((a) => isBlockedAddress(a.address, a.family));
    if (blocked) {
      throw new DomainError({
        code: "endpoint_not_allowed",
        message:
          "Base URL resolves to a private/internal/loopback/reserved address, which is not allowed unless local-inference mode is explicitly enabled for this connection",
        details: { hostname, blockedAddress: blocked.address },
      });
    }
  }
}
