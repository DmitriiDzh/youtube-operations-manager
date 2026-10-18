import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceSecretSlot } from "@/lib/device-secrets";
import { DomainError } from "@/lib/shared-domain";
import { createHfTokenServices } from "./hf-token";

// BL-134 (FO-REQ-0028 §2A, DEVICE_SECRETS_PLAN.md): a token is checked with Hugging Face before it is stored; no view carries it;
// a check result lands only on the token that was checked.

const TOKEN = "hf_" + "a".repeat(34);

function memorySlot() {
  let row: { value: string; hints: Record<string, string | null>; status: string | null; verifiedAt: number | null; revision: number } | null = null;
  const slot = {
    name: "huggingface",
    async state() {
      return row ? "set" : "none";
    },
    async info() {
      return row ? { hints: row.hints, status: row.status, verifiedAt: row.verifiedAt, updatedAt: 1_760_000_000_000, revision: row.revision } : null;
    },
    async read() {
      return row?.value ?? null;
    },
    async write(value: string, input: { hints: Record<string, string | null>; status?: string | null; verifiedAt?: number | null }) {
      row = { value, hints: input.hints, status: input.status ?? null, verifiedAt: input.verifiedAt ?? null, revision: (row?.revision ?? 0) + 1 };
      return { hints: row.hints, status: row.status, verifiedAt: row.verifiedAt, updatedAt: 1, revision: row.revision };
    },
    async setStatus(expected: number, patch: { status?: string | null; verifiedAt?: number | null }) {
      if (!row || row.revision !== expected) return false;
      row = { ...row, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}) };
      return true;
    },
    async clear() {
      row = null;
    },
  } as unknown as DeviceSecretSlot;
  return slot;
}

test("setHfToken: whoami first, then stored with the user name; the view never carries the token", async () => {
  const slot = memorySlot();
  const asked: string[] = [];
  const services = createHfTokenServices({ slot, hub: { whoami: async (t) => (asked.push(t), { name: "owner-hf" }) }, now: () => 1_760_000_000_000 });
  const view = await services.setHfToken({ token: TOKEN });
  assert.deepEqual(asked, [TOKEN]);
  assert.deepEqual({ state: view.state, user: view.user, status: view.status }, { state: "set", user: "owner-hf", status: "ok" });
  assert.ok(!JSON.stringify(view).includes(TOKEN));
  assert.equal(await services.readHfToken(), TOKEN);
});

test("setHfToken: a refused token stores nothing; a malformed one is refused before any call", async () => {
  const slot = memorySlot();
  let calls = 0;
  const services = createHfTokenServices({
    slot,
    hub: {
      whoami: async () => {
        calls += 1;
        throw new DomainError({ code: "hf_token_invalid", message: "refused" });
      },
    },
  });
  await assert.rejects(services.setHfToken({ token: TOKEN }), (e: unknown) => e instanceof DomainError && e.code === "hf_token_invalid");
  assert.equal((await services.getHfToken()).state, "none");
  await assert.rejects(services.setHfToken({ token: "not-a-token" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(calls, 1);
});

test("testHfToken: ok stamps the token that was checked; a refusal marks it invalid and rethrows; no token is hf_token_missing", async () => {
  const slot = memorySlot();
  let refuse = false;
  const services = createHfTokenServices({
    slot,
    hub: {
      whoami: async () => {
        if (refuse) throw new DomainError({ code: "hf_token_invalid", message: "refused" });
        return { name: "owner-hf" };
      },
    },
    now: () => 1_760_000_100_000,
  });
  await assert.rejects(services.testHfToken(), (e: unknown) => e instanceof DomainError && e.code === "hf_token_missing");
  await services.setHfToken({ token: TOKEN });
  assert.equal((await services.testHfToken()).verifiedAt, new Date(1_760_000_100_000).toISOString());
  refuse = true;
  await assert.rejects(services.testHfToken(), (e: unknown) => e instanceof DomainError && e.code === "hf_token_invalid");
  assert.equal((await services.getHfToken()).status, "invalid");
  assert.equal((await services.clearHfToken()).state, "none");
});
