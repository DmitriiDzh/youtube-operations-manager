import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { redirectUriFor } from "./shared";

// BL-252: Meta's app enforces HTTPS and refuses http://localhost (owner msgs 4315/4319), so the only return address is the owner's
// HTTPS Tailscale name of this Mac (BL-251: `tailscale serve` keeps that Host and adds Tailscale-User-Login).
const h = (o: Record<string, string>) => new Headers(o);

test("redirectUriFor: the HTTPS tailnet address only; localhost and foreign hosts refused (AC-XP-12 amended 14.11)", () => {
  assert.equal(
    redirectUriFor(h({ host: "mac-mini.rohu-quillback.ts.net", "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" })),
    "https://mac-mini.rohu-quillback.ts.net/api/social/meta/callback"
  );
  for (const headers of [h({ host: "localhost:3000" }), h({ host: "127.0.0.1:3000" }), h({ host: "evil.example" }), h({ host: "evil.ts.net:8080" }), h({})]) {
    assert.throws(() => redirectUriFor(headers), (e: unknown) => e instanceof DomainError && e.code === "social_https_required");
  }
});
