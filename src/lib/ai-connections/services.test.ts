import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { StoredAiConnection, StoredAiConnectionCredential } from "@/lib/db";
import { decryptSecret } from "./crypto";
import { createAiConnectionServices } from "./services";
import { DomainError, type AdapterType, type ConnectionProtocolAdapter } from "./contracts";
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible";

function makeFixture() {
  const connections = new Map<string, StoredAiConnection>();
  const credentials = new Map<string, StoredAiConnectionCredential>();
  let counter = 0;
  const now = () => new Date();

  const connectionStore = {
    async createConnection(input: Omit<StoredAiConnection, "status" | "statusMessage" | "statusCheckedAt" | "createdAt" | "updatedAt">) {
      const stored: StoredAiConnection = {
        ...input,
        status: "unknown",
        statusMessage: null,
        statusCheckedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      connections.set(input.id, stored);
      return stored;
    },
    async listConnections() {
      return [...connections.values()];
    },
    async getConnection(id: string) {
      return connections.get(id) ?? null;
    },
    async updateConnection(id: string, patch: Partial<StoredAiConnection>) {
      const existing = connections.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: now() };
      connections.set(id, updated);
      return updated;
    },
    async deleteConnection(id: string) {
      connections.delete(id);
      credentials.delete(id);
    },
  };

  const credentialStore = {
    async upsertCredential(input: StoredAiConnectionCredential) {
      credentials.set(input.connectionId, input);
    },
    async getCredential(id: string) {
      return credentials.get(id) ?? null;
    },
    async deleteCredential(id: string) {
      credentials.delete(id);
    },
  };

  let encryptionKey: Buffer | null = randomBytes(32);

  const logger = { info() {}, error() {} };

  function build(protocolAdapters: Partial<Record<AdapterType, ConnectionProtocolAdapter>> = {}) {
    return createAiConnectionServices({
      connectionStore,
      credentialStore,
      resolveEncryptionKey: () => encryptionKey,
      protocolAdapters: protocolAdapters as Record<AdapterType, ConnectionProtocolAdapter>,
      idGenerator: () => `conn-${++counter}`,
      logger,
    });
  }

  return {
    build,
    credentials,
    getEncryptionKey: () => encryptionKey!,
    setEncryptionKeyMissing() {
      encryptionKey = null;
    },
  };
}

const BASE_INPUT = {
  displayName: "Test connection",
  adapterType: "openai_compatible" as const,
  baseUrl: "https://api.example.com/v1",
  modelId: "some-model",
  capabilities: { structuredOutput: "json_object" as const },
};

// AC-CONN-01
test("AC-CONN-01: the submitted credential never appears anywhere in the create response", async () => {
  const { build } = makeFixture();
  const services = build();

  const secret = "sk-secret-value-do-not-leak";
  const connection = await services.createConnection({ ...BASE_INPUT, apiKey: secret });

  assert.equal(connection.hasCredential, true);
  assert.ok(!JSON.stringify(connection).includes(secret));
});

// AC-CONN-02 (at the service layer -- crypto.test.ts covers the crypto primitive itself)
test("AC-CONN-02: the stored credential is encrypted, and decrypts back to the exact original", async () => {
  const { build, credentials, getEncryptionKey } = makeFixture();
  const services = build();
  const secret = "sk-round-trip-value";

  const connection = await services.createConnection({ ...BASE_INPUT, apiKey: secret });
  const stored = credentials.get(connection.id)!;

  assert.ok(!stored.ciphertext.includes(secret));
  const decrypted = decryptSecret(stored, getEncryptionKey());
  assert.equal(decrypted, secret);
});

// AC-CONN-03
test("AC-CONN-03: without a configured encryption key, creating a connection WITH a credential fails closed", async () => {
  const { build, setEncryptionKeyMissing } = makeFixture();
  setEncryptionKeyMissing();
  const services = build();

  await assert.rejects(
    services.createConnection({ ...BASE_INPUT, apiKey: "sk-secret" }),
    (err: unknown) => err instanceof DomainError && err.code === "encryption_key_not_configured"
  );

  const list = await services.listConnections();
  assert.equal(list.length, 0);
});

test("without a configured encryption key, a connection WITHOUT a credential can still be created", async () => {
  const { build, setEncryptionKeyMissing } = makeFixture();
  setEncryptionKeyMissing();
  const services = build();

  const connection = await services.createConnection({ ...BASE_INPUT, apiKey: undefined });
  assert.equal(connection.hasCredential, false);
});

// AC-CONN-04
test("AC-CONN-04: full CRUD lifecycle -- create, edit, disable, delete", async () => {
  const { build } = makeFixture();
  const services = build();

  const created = await services.createConnection({ ...BASE_INPUT, apiKey: undefined });
  const edited = await services.updateConnection({ connectionId: created.id, displayName: "Renamed", modelId: "new-model" });
  assert.equal(edited.displayName, "Renamed");
  assert.equal(edited.modelId, "new-model");

  const disabled = await services.updateConnection({ connectionId: created.id, enabled: false });
  assert.equal(disabled.enabled, false);

  await services.deleteConnection({ connectionId: created.id });
  await assert.rejects(
    services.getConnection({ connectionId: created.id }),
    (err: unknown) => err instanceof DomainError && err.code === "not_found"
  );
});

// AC-CONN-05
test("AC-CONN-05: credential replacement and independent explicit clearing", async () => {
  const { build, credentials } = makeFixture();
  const services = build();

  const created = await services.createConnection({ ...BASE_INPUT, apiKey: "secret-A" });
  const afterReplace = await services.updateConnection({ connectionId: created.id, apiKey: "secret-B" });
  assert.equal(afterReplace.hasCredential, true);

  const afterClear = await services.updateConnection({ connectionId: created.id, apiKey: null });
  assert.equal(afterClear.hasCredential, false);
  assert.equal(credentials.has(created.id), false);

  // The connection itself must still exist after clearing its credential.
  const stillThere = await services.getConnection({ connectionId: created.id });
  assert.equal(stillThere.id, created.id);
});

// AC-CONN-10 (using the REAL openai-compatible adapter, with a spy fetch, so the
// capability check under test is the actual production logic, not a fake stand-in).
test("AC-CONN-10: an unsupported capability produces an explicit error before any network call", async () => {
  let fetchCalls = 0;
  const spyFetch = async () => {
    fetchCalls += 1;
    throw new Error("must not be called");
  };
  const realAdapter = createOpenAiCompatibleAdapter({ fetchImpl: spyFetch });
  const { build } = makeFixture();
  const services = build({ openai_compatible: realAdapter });

  const connection = await services.createConnection({
    ...BASE_INPUT,
    capabilities: { structuredOutput: "none" },
    apiKey: undefined,
  });

  const provider = await services.resolveConnectionProvider(connection.id);
  await assert.rejects(
    provider.generate({ videoId: "v1", targetLanguage: "es", sourceLanguage: "en", sourceTitle: "T", sourceDescription: "D" }),
    (err: unknown) => err instanceof DomainError && err.code === "capability_not_supported"
  );
  assert.equal(fetchCalls, 0);
});

// AC-CONN-15
test("AC-CONN-15: testConnection reports mayIncurCost per adapter type", async () => {
  const { build } = makeFixture();
  const mockAdapter: ConnectionProtocolAdapter = {
    adapterType: "mock",
    async generate() {
      return { outcome: { status: "ok", title: "x", description: "y" }, usage: null };
    },
    async testConnection() {
      return { ok: true, message: "mock ok", mayIncurCost: false };
    },
  };
  const realAdapter: ConnectionProtocolAdapter = {
    adapterType: "openai_compatible",
    async generate() {
      return { outcome: { status: "ok", title: "x", description: "y" }, usage: null };
    },
    async testConnection() {
      return { ok: true, message: "real ok", mayIncurCost: true };
    },
  };
  const services = build({ mock: mockAdapter, openai_compatible: realAdapter });

  const mockConn = await services.createConnection({ ...BASE_INPUT, adapterType: "mock", baseUrl: null, apiKey: undefined });
  const realConn = await services.createConnection({ ...BASE_INPUT, apiKey: undefined });

  const mockResult = await services.testConnection({ connectionId: mockConn.id });
  const realResult = await services.testConnection({ connectionId: realConn.id });

  assert.equal(mockResult.mayIncurCost, false);
  assert.equal(realResult.mayIncurCost, true);
});

test("testConnection is never called automatically by createConnection/updateConnection/listConnections", async () => {
  const { build } = makeFixture();
  let testCalls = 0;
  const adapter: ConnectionProtocolAdapter = {
    adapterType: "openai_compatible",
    async generate() {
      return { outcome: { status: "ok", title: "x", description: "y" }, usage: null };
    },
    async testConnection() {
      testCalls += 1;
      return { ok: true, message: "ok", mayIncurCost: true };
    },
  };
  const services = build({ openai_compatible: adapter });

  const created = await services.createConnection({ ...BASE_INPUT, apiKey: undefined });
  await services.updateConnection({ connectionId: created.id, displayName: "Renamed" });
  await services.listConnections();

  assert.equal(testCalls, 0);
});
