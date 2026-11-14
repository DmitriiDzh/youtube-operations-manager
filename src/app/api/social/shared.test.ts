import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { redirectUriFor } from "./shared";

// BL-252: connecting is Mac-only (CROSS_POSTING_PLAN.md AC-XP-12), so Meta sends the owner back to localhost only.
const h = (o: Record<string, string>) => new Headers(o);

test("redirectUriFor: localhost on the Mac; refused over Tailscale, for a foreign Host or Origin (AC-XP-12)", () => {
  assert.equal(redirectUriFor(h({ host: "localhost:3000" })), "http://localhost:3000/api/social/meta/callback");
  assert.equal(redirectUriFor(h({ host: "127.0.0.1:3000" })), "http://localhost:3000/api/social/meta/callback");
  for (const headers of [
    h({ host: "mac-mini.rohu-quillback.ts.net", "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" }),
    h({ host: "localhost:3000", "tailscale-user-login": "owner@example.com" }),
    h({ host: "evil.example" }),
    h({ host: "localhost:3000", origin: "https://evil.example" }),
    h({}),
  ]) {
    assert.throws(() => redirectUriFor(headers), (e: unknown) => e instanceof DomainError && e.code === "remote_access_mac_only");
  }
});
