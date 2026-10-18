import assert from "node:assert/strict";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore, type DeviceSecretSlot } from "@/lib/device-secrets";
import { DomainError } from "@/lib/shared-domain";
import { createHfTokenServices } from "./hf-token";

// BL-134 (FO-REQ-0028 §2A, DEVICE_SECRETS_PLAN.md): a token is checked with Hugging Face before it is stored; no view carries it;
// a check result lands only on the token that was checked.

const TOKEN = "hf_" + "a".repeat(34);

/** The real store over an in-memory table and key file (BL-199): the slot behaves exactly as in production. */
function memorySlot(): DeviceSecretSlot {
  let keyText: string | null = null;
  const access: KeyFileAccess = {
    read: async () => keyText,
    write: async (content) => void (keyText = JSON.stringify(content)),
    remove: async () => void (keyText = null),
    randomBytes: (n) => Buffer.alloc(n, 5),
  };
  return createDeviceSecrets({
    store: createMemoryDeviceSecretStore(),
    keyFile: createKeyFile(access, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
  }).slot("huggingface");
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
