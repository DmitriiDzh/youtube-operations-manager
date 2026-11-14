import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { hasRemoteForwarding, isLoopbackRequest, isRemoteRequest } from "@/lib/loopback-guard";
import { isSameOriginMutation } from "./classify";
import { createRemoteAccessServices, stateFromJson } from "./services";

// BL-251 acceptance (docs/roadmap/plans/REMOTE_ACCESS_PLAN.md AC-RA-1/2/4/6/7), from the plan's rules, not the code.

const h = (o: Record<string, string>) => new Headers(o);

// Real header sets, measured 2026-11-14 (security review C1 + a real `tailscale serve` 1.104.7 on this Mac):
// Next.js fills these in on EVERY request from the socket -- here a plain local `curl http://127.0.0.1:3000`.
const NEXT_LOCAL = { host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http", "x-forwarded-port": "3000" };
// What `tailscale serve` delivered for a tailnet request (forged Tailscale-User-Login / X-Forwarded-For were overwritten).
const TAILSCALE = { host: "mac-mini.tail15ae15.ts.net", "x-forwarded-for": "100.92.125.11", "x-forwarded-host": "mac-mini.tail15ae15.ts.net", "tailscale-user-login": "owner@example.com", "tailscale-user-name": "Owner" };

test("AC-RA-1: the Mac's own requests (with Next's loopback x-forwarded-*) are local; tailscale serve's are remote", () => {
  assert.equal(isRemoteRequest(h(NEXT_LOCAL)), false);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, "x-forwarded-for": "::1" })), false);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, host: "localhost:3000", "x-forwarded-host": "localhost:3000", "x-forwarded-for": "127.0.0.1" })), false);
  assert.equal(isRemoteRequest(h(TAILSCALE)), true);
  // a proxy that rewrote Host to loopback is still caught by any one of its marks
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, "x-forwarded-for": "100.92.125.11" })), true);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, "x-forwarded-host": "mac-mini.tail15ae15.ts.net" })), true);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, "tailscale-user-login": "owner@example.com" })), true);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, forwarded: "for=100.64.0.7" })), true);
  assert.equal(isRemoteRequest(h({ ...NEXT_LOCAL, "x-forwarded-for": "100.64.0.7, 127.0.0.1" })), true);
  assert.equal(isRemoteRequest(h({})), true); // no Host at all: fail closed
  assert.equal(hasRemoteForwarding(h(NEXT_LOCAL)), false);
});

test("AC-RA-2: isLoopbackRequest stays true for the Mac (agents keep working) and is false through tailscale serve", () => {
  assert.equal(isLoopbackRequest(h(NEXT_LOCAL)), true);
  assert.equal(isLoopbackRequest(h({ ...TAILSCALE, host: "127.0.0.1:3000" })), false);
  assert.equal(isLoopbackRequest(h(TAILSCALE)), false);
});

test("CSRF: a remote mutation must come from a page of this same host (scheme not compared: no X-Forwarded-Proto)", () => {
  assert.equal(isSameOriginMutation(h({ ...TAILSCALE, origin: "https://mac-mini.tail15ae15.ts.net" })), true);
  assert.equal(isSameOriginMutation(h({ ...TAILSCALE, "x-forwarded-proto": "http", origin: "https://mac-mini.tail15ae15.ts.net" })), true);
  assert.equal(isSameOriginMutation(h({ ...TAILSCALE, origin: "https://evil.example" })), false);
  assert.equal(isSameOriginMutation(h({ ...TAILSCALE, origin: "null" })), false);
  assert.equal(isSameOriginMutation(h(TAILSCALE)), false); // no Origin
});

function services(start = 1_000_000) {
  let file: string | null = null;
  const clock = { t: start };
  const svc = createRemoteAccessServices({ store: { read: async () => file, write: async (j) => void (file = j) }, clock: { now: () => clock.t } });
  return { svc, clock, file: () => file };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(isDomainError(e), String(e));
    return e.code;
  }
  return "ok";
}

test("AC-RA-4: password >= 8 characters, stored as a scrypt hash (never the password), right/wrong checked", async () => {
  const { svc, file } = services();
  assert.equal(await code(svc.setPassword("short7c")), "validation_failed");
  await svc.setPassword("correct horse");
  assert.equal(file()!.includes("correct horse"), false);
  assert.equal((await svc.status()).enabled, true); // owner msg 4228: on by default once a password exists
  await svc.setEnabled(false);
  assert.equal(await code(svc.verifyPassword("correct horse", null)), "remote_access_disabled"); // switched off explicitly
  await svc.setPassword("correct horse"); // a new password keeps an explicit off
  assert.equal((await svc.status()).enabled, false);
  await svc.setEnabled(true);
  assert.equal(await code(svc.verifyPassword("wrong pass", null)), "remote_access_bad_password");
  assert.equal(await code(svc.verifyPassword("correct horse", null)), "ok");
  const st = await svc.status();
  assert.deepEqual(Object.keys(st).sort(), ["enabled", "epoch", "lockedUntil", "ownerLogin", "passwordSet"]); // AC-RA-7
});

test("AC-RA-4: 5 wrong passwords in 15 minutes lock every attempt (even the right one) for 15 minutes", async () => {
  const { svc, clock } = services();
  await svc.setPassword("correct horse");
  await svc.setEnabled(true);
  for (let i = 0; i < 5; i++) {
    clock.t += 1000;
    assert.equal(await code(svc.verifyPassword("nope nope", null)), "remote_access_bad_password");
  }
  assert.equal(await code(svc.verifyPassword("correct horse", null)), "remote_access_locked");
  clock.t += 15 * 60_000 + 1;
  assert.equal(await code(svc.verifyPassword("correct horse", null)), "ok");
});

test("AC-RA-6: a password change or the switch going off ends earlier phone sessions (epoch); the Tailscale login is pinned", async () => {
  const { svc } = services();
  await svc.setPassword("correct horse");
  await svc.setEnabled(true);
  const { epoch } = await svc.verifyPassword("correct horse", "owner@example.com");
  assert.equal(await svc.sessionValid(epoch, "owner@example.com"), true);
  assert.equal(await svc.sessionValid(epoch, "someone@else.com"), false); // pinned at the first success
  assert.equal(await code(svc.verifyPassword("correct horse", "someone@else.com")), "remote_access_bad_password");
  await svc.setPassword("another horse");
  assert.equal(await svc.sessionValid(epoch, "owner@example.com"), false);
  const second = await svc.verifyPassword("another horse", "owner@example.com");
  await svc.setEnabled(false);
  assert.equal(await svc.sessionValid(second.epoch, "owner@example.com"), false);
  assert.equal((await svc.status()).ownerLogin, null); // switch-off forgets the pinned login
});

test("a damaged state file never opens remote access; with a valid password the default is on (owner msg 4228)", () => {
  assert.equal(stateFromJson("{not json").enabled, false);
  assert.equal(stateFromJson(JSON.stringify({ enabled: true })).enabled, false); // no password
  assert.equal(stateFromJson(JSON.stringify({ enabled: true, passwordHash: "zz", salt: "zz" })).enabled, false);
  const hex = "ab".repeat(16);
  assert.equal(stateFromJson(JSON.stringify({ passwordHash: hex, salt: hex })).enabled, true);
  assert.equal(stateFromJson(JSON.stringify({ enabled: false, passwordHash: hex, salt: hex })).enabled, false);
});
