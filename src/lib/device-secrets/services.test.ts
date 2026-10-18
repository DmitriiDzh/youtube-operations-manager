import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKeyFile, createKeyFileFsAccess } from "@/lib/device-key-file";
import { encryptSecret } from "@/lib/shared-crypto";
import { DomainError } from "@/lib/shared-domain";
import type { DeviceSecretStorePort, LegacySecretSource, StoredDeviceSecretRow } from "./contracts";
import { createDeviceSecrets } from "./services";

// BL-199 (docs/roadmap/plans/DEVICE_SECRETS_PLAN.md AC-DS-01..08, ADR 0042). Expected values follow the plan's rules: "set" = row +
// readable key file; clearing removes one row, never the shared file unless it is unusable; a legacy secret moves once, verified,
// and never comes back after a clear.

function memoryStore() {
  const rows = new Map<string, StoredDeviceSecretRow>();
  const migrated = new Set<string>();
  const port: DeviceSecretStorePort = {
    async get(name) {
      const row = rows.get(name);
      return row ? { ...row, hints: { ...row.hints } } : null;
    },
    async upsert(row) {
      const previous = rows.get(row.name);
      rows.set(row.name, { ...row, revision: previous ? previous.revision + 1 : 1 });
    },
    async setStatus(name, expectedRevision, patch) {
      const row = rows.get(name);
      if (!row || row.revision !== expectedRevision) return false;
      rows.set(name, { ...row, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}) });
      return true;
    },
    async delete(name) {
      rows.delete(name);
    },
    async isMigrated(name) {
      return migrated.has(name);
    },
    async markMigrated(name) {
      migrated.add(name);
    },
  };
  return { port, rows, migrated };
}

function invalid(detail: string) {
  return new DomainError({ code: "encryption_key_not_configured", message: detail });
}

async function tempKeyFilePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "device-secrets-")), "device-secrets.key");
}

async function build(options: { legacy?: Partial<Record<"runpod" | "gemini", LegacySecretSource>>; legacySealKey?: () => Promise<Buffer | null> } = {}) {
  const store = memoryStore();
  const keyPath = await tempKeyFilePath();
  const secrets = createDeviceSecrets({ store: store.port, keyFile: createKeyFile(createKeyFileFsAccess(keyPath), invalid), legacy: options.legacy, legacySealKey: options.legacySealKey, now: () => 1_760_000_000_000 });
  return { secrets, store, keyPath };
}

test("AC-DS-01: write then read gives the value back; the row holds no plaintext; the key file is created 0600", async () => {
  const { secrets, store, keyPath } = await build();
  await secrets.slot("huggingface").write("s3cr3t-token", { hints: { user: "owner" } });
  assert.equal(await secrets.slot("huggingface").read(), "s3cr3t-token");
  const row = store.rows.get("huggingface");
  assert.ok(row && !row.ciphertext.includes("s3cr3t") && !JSON.stringify(row).includes("s3cr3t-token"));
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.deepEqual((await secrets.slot("huggingface").info())?.hints, { user: "owner" });
});

test("AC-DS-02: state none / set / key_file_missing / key_file_invalid; a foreign row fails with device_secret_unreadable", async () => {
  const { secrets, store, keyPath } = await build();
  assert.equal(await secrets.slot("gemini").state(), "none");
  await secrets.slot("gemini").write("AIza-key", { hints: {} });
  assert.equal(await secrets.slot("gemini").state(), "set");

  // A row sealed with another key (e.g. copied from another computer).
  const foreign = encryptSecret("other", Buffer.alloc(32, 7));
  store.rows.set("gemini", { ...store.rows.get("gemini")!, ...foreign });
  await assert.rejects(secrets.slot("gemini").read(), (e: unknown) => e instanceof DomainError && e.code === "device_secret_unreadable");

  await writeFile(keyPath, "not json");
  assert.equal(await secrets.slot("gemini").state(), "key_file_invalid");

  const fresh = await build();
  fresh.store.rows.set("gemini", { name: "gemini", ...foreign, hints: {}, status: null, verifiedAt: null, updatedAt: 1, revision: 1 });
  assert.equal(await fresh.secrets.slot("gemini").state(), "key_file_missing");
  await assert.rejects(fresh.secrets.slot("gemini").read(), (e: unknown) => e instanceof DomainError && e.code === "device_secret_unreadable");
});

test("AC-DS-03: clearing one secret removes only its row; the key file stays unless it is unusable", async () => {
  const { secrets, store, keyPath } = await build();
  await secrets.slot("gemini").write("g", { hints: {} });
  await secrets.slot("huggingface").write("h", { hints: {} });
  await secrets.slot("gemini").clear();
  assert.equal(store.rows.has("gemini"), false);
  assert.equal(await secrets.slot("huggingface").read(), "h");
  await stat(keyPath);

  await writeFile(keyPath, "{}");
  await secrets.slot("huggingface").clear();
  await assert.rejects(stat(keyPath), "an unusable key file goes with the cleared row");
});

test("AC-DS-04: a status update with a stale revision changes nothing", async () => {
  const { secrets } = await build();
  const first = await secrets.slot("gemini").write("k1", { hints: {}, status: "ok" });
  await secrets.slot("gemini").write("k2", { hints: {}, status: "ok" });
  assert.equal(await secrets.slot("gemini").setStatus(first.revision, { status: "payment_required" }), false);
  assert.equal((await secrets.slot("gemini").info())?.status, "ok");
  const current = (await secrets.slot("gemini").info())!;
  assert.equal(await secrets.slot("gemini").setStatus(current.revision, { status: "payment_required", verifiedAt: 5 }), true);
  assert.deepEqual([(await secrets.slot("gemini").info())?.status, (await secrets.slot("gemini").info())?.verifiedAt], ["payment_required", 5]);
});

test("AC-DS-05: seal/open with this store's key; a token sealed with the legacy key opens through the fallback; neither -> null", async () => {
  const legacyKey = Buffer.alloc(32, 3);
  const { secrets } = await build({ legacySealKey: async () => legacyKey });
  assert.equal(await secrets.seal("tok"), null, "no key file yet: nothing to seal with");
  await secrets.slot("runpod").write("{}", { hints: {} });
  const sealed = (await secrets.seal("tok"))!;
  assert.equal(await secrets.open(sealed), "tok");
  assert.equal(await secrets.open(encryptSecret("old-tok", legacyKey)), "old-tok");
  assert.equal(await secrets.open(encryptSecret("x", Buffer.alloc(32, 9))), null);
});

test("AC-DS-06: a legacy Gemini key moves on first read -- same value, hints and status kept, marker set; the legacy row is read once", async () => {
  let legacyReads = 0;
  const legacy: LegacySecretSource = {
    async read() {
      legacyReads += 1;
      return { plaintext: "AIza-legacy", hints: { keyHint: "gacy" }, status: "ok", verifiedAt: 1_759_000_000_000 };
    },
  };
  const { secrets, store } = await build({ legacy: { gemini: legacy } });
  assert.equal(await secrets.slot("gemini").state(), "set");
  assert.equal(await secrets.slot("gemini").read(), "AIza-legacy");
  assert.deepEqual((await secrets.slot("gemini").info())?.hints, { keyHint: "gacy" });
  assert.equal((await secrets.slot("gemini").info())?.verifiedAt, 1_759_000_000_000);
  assert.ok(store.migrated.has("gemini"));
  assert.equal(legacyReads, 1);
});

test("AC-DS-07: after the move, clearing leaves the slot empty and the legacy row never comes back", async () => {
  const legacy: LegacySecretSource = { read: async () => ({ plaintext: "AIza-legacy", hints: {}, status: null, verifiedAt: null }) };
  const { secrets } = await build({ legacy: { gemini: legacy } });
  await secrets.slot("gemini").read();
  await secrets.slot("gemini").clear();
  assert.equal(await secrets.slot("gemini").read(), null);
  assert.equal(await secrets.slot("gemini").state(), "none");
});

test("AC-DS-08: a legacy row whose key file is missing is not moved: state key_file_missing, no marker; a new save fixes it", async () => {
  const legacy: LegacySecretSource = { read: async () => "unreadable" };
  const { secrets, store } = await build({ legacy: { runpod: legacy } });
  assert.equal(await secrets.slot("runpod").state(), "key_file_missing");
  assert.equal(await secrets.slot("runpod").read(), null);
  assert.equal(store.migrated.has("runpod"), false);
  await secrets.slot("runpod").write('{"runpodApiKey":"rpa_x"}', { hints: {} });
  assert.equal(await secrets.slot("runpod").state(), "set");
  assert.ok(store.migrated.has("runpod"));
});

test("AC-DS-09: the RunPod set moves with its prefix and S3 id hints and its verifiedAt in ms", async () => {
  const set = JSON.stringify({ runpodApiKey: "rpa_ABCDEFGH", s3AccessKeyId: "user_1", s3SecretAccessKey: "rps_secret" });
  const legacy: LegacySecretSource = { read: async () => ({ plaintext: set, hints: { runpodKeyPrefix: "rpa_ABCD…", s3AccessKeyId: "user_1" }, status: null, verifiedAt: 1_759_500_000_000 }) };
  const { secrets } = await build({ legacy: { runpod: legacy } });
  assert.equal(await secrets.slot("runpod").read(), set);
  assert.deepEqual(await secrets.slot("runpod").info().then((i) => ({ hints: i?.hints, verifiedAt: i?.verifiedAt })), {
    hints: { runpodKeyPrefix: "rpa_ABCD…", s3AccessKeyId: "user_1" },
    verifiedAt: 1_759_500_000_000,
  });
});

test("migration: no legacy row -> marked once, nothing stored; two first reads at once move it once", async () => {
  let reads = 0;
  const empty: LegacySecretSource = {
    async read() {
      reads += 1;
      return null;
    },
  };
  const { secrets, store } = await build({ legacy: { gemini: empty } });
  await Promise.all([secrets.slot("gemini").state(), secrets.slot("gemini").read(), secrets.slot("gemini").info()]);
  assert.equal(reads, 1);
  assert.ok(store.migrated.has("gemini"));
  assert.equal(store.rows.has("gemini"), false);
});
