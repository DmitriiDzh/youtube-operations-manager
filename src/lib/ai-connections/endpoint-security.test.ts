import assert from "node:assert/strict";
import test from "node:test";
import { validateEndpointUrl, raceDnsLookupAgainstTimeout } from "./endpoint-security";
import { DomainError } from "./contracts";

async function expectRejected(url: string, allowLocal: boolean) {
  await assert.rejects(
    validateEndpointUrl(url, { allowLocal }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );
}

async function expectAccepted(url: string, allowLocal: boolean) {
  await validateEndpointUrl(url, { allowLocal });
}

// AC-CONN-07
test("AC-CONN-07: private/internal/loopback/metadata addresses are blocked by default, allowed only with allowLocal", async () => {
  const cases = ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:11434", "http://192.168.1.10:8000", "http://10.0.0.5"];
  for (const url of cases) {
    await expectRejected(url, false);
    await expectAccepted(url, true);
  }
});

test("AC-CONN-07: IPv6 loopback and unique-local addresses are blocked by default", async () => {
  await expectRejected("http://[::1]:11434", false);
  await expectRejected("http://[fd00::1]", false);
  await expectAccepted("http://[::1]:11434", true);
});

// AC-CONN-08
test("AC-CONN-08: plain HTTP to a public host is rejected unless allowLocal", async () => {
  await expectRejected("http://api.example.com/v1", false);
});

test("AC-CONN-08: HTTPS to a public host passes protocol validation (DNS mocked to a public address)", async () => {
  await validateEndpointUrl("https://api.example.com/v1", {
    allowLocal: false,
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
});

// AC-CONN-09
test("AC-CONN-09: a hostname that RESOLVES to a private address is blocked even though the hostname string looks public", async () => {
  await assert.rejects(
    validateEndpointUrl("https://looks-public.example.com/v1", {
      allowLocal: false,
      dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );
});

test("AC-CONN-09: a hostname resolving to a genuinely public address is accepted", async () => {
  await validateEndpointUrl("https://looks-public.example.com/v1", {
    allowLocal: false,
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
});

test("IPv6 literal URLs are checked directly and never trigger a DNS lookup (fast path, not just the DNS-fallback path)", async () => {
  const failingDnsLookup = async () => {
    throw new Error("dnsLookup should never be called for an IP literal");
  };

  // Blocked loopback/unique-local literals: must be rejected using the direct-IP
  // check alone, without ever invoking the (here, deliberately failing) resolver.
  await assert.rejects(
    validateEndpointUrl("http://[::1]:11434", { allowLocal: false, dnsLookup: failingDnsLookup }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );
  await assert.rejects(
    validateEndpointUrl("http://[fd00::1]", { allowLocal: false, dnsLookup: failingDnsLookup }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );

  // A genuinely public IPv6 literal must be accepted without a DNS lookup either.
  await validateEndpointUrl("https://[2001:4860:4860::8888]/", { allowLocal: false, dnsLookup: failingDnsLookup });
});

// Independent test-suite audit (2026-09-26): isBlockedIpv6's `::ffff:`-prefix unwrap-and-recheck
// branch had zero test coverage. Verified separately that a LITERAL bracketed URL never actually
// reaches this branch either way -- `new URL("https://[::ffff:169.254.169.254]/").hostname`
// normalizes to the WHATWG hex form (e.g. "[::ffff:a9fe:a9fe]"), not the dotted-quad form this
// unwrap logic parses, so a literal URL always falls through to "block conservatively" instead.
// The only way to actually exercise the dotted-quad-aware branch is via a DNS resolver returning
// a raw `{address: "::ffff:x.x.x.x", family: 6}` record, which these two tests do directly.
test("a DNS resolution returning an IPv4-mapped IPv6 metadata address (::ffff:169.254.169.254) is blocked", async () => {
  await assert.rejects(
    validateEndpointUrl("https://looks-public.example.com/v1", {
      allowLocal: false,
      dnsLookup: async () => [{ address: "::ffff:169.254.169.254", family: 6 }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );
});

test("a DNS resolution returning an IPv4-mapped IPv6 genuinely public address (::ffff:8.8.8.8) is accepted", async () => {
  await validateEndpointUrl("https://looks-public.example.com/v1", {
    allowLocal: false,
    dnsLookup: async () => [{ address: "::ffff:8.8.8.8", family: 6 }],
  });
});

test("a hanging DNS lookup is bounded by its own timeout and fails closed, rather than hanging forever", async () => {
  const neverResolves = new Promise<Array<{ address: string; family: number }>>(() => {});
  await assert.rejects(
    raceDnsLookupAgainstTimeout(neverResolves, "hangs.example.com", 20),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed" && /timed out/.test(err.message)
  );
});

test("a malformed URL is rejected", async () => {
  await assert.rejects(
    validateEndpointUrl("not-a-url", { allowLocal: false }),
    (err: unknown) => err instanceof DomainError && err.code === "endpoint_not_allowed"
  );
});
