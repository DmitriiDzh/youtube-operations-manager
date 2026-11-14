import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { redirectUriFor } from "./shared";

// BL-252: Meta must send the owner back to the address the browser is on -- localhost on the Mac, the tailnet name over
// Tailscale (as measured for BL-251: `tailscale serve` keeps the tailnet Host and adds Tailscale-User-Login). Nothing else.
const h = (o: Record<string, string>) => new Headers(o);

test("redirectUriFor: localhost on the Mac, https tailnet name over Tailscale, refused otherwise", () => {
  assert.equal(redirectUriFor(h({ host: "localhost:3000" })), "http://localhost:3000/api/social/meta/callback");
  assert.equal(redirectUriFor(h({ host: "127.0.0.1:3000" })), "http://localhost:3000/api/social/meta/callback");
  assert.equal(
    redirectUriFor(h({ host: "mac-mini.rohu-quillback.ts.net", "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" })),
    "https://mac-mini.rohu-quillback.ts.net/api/social/meta/callback"
  );
  for (const headers of [h({ host: "evil.example" }), h({ host: "localhost:3000", origin: "https://evil.example" }), h({})]) {
    assert.throws(() => redirectUriFor(headers), (e: unknown) => e instanceof DomainError && e.code === "remote_access_mac_only");
  }
});
