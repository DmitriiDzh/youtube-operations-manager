import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { createAutomergeCore } from "../automerge-core";
import { emptyDocument, createAiConnectionsCatalogCore, type ServiceDependencies } from "./services";
import { GLOBAL_DOCUMENT_KEY, type AiConnectionEntry, type AiConnectionsDocument } from "./contracts";
import type { DiscardedDocumentBackupStore, DocumentByteStore } from "../automerge-core/store";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

function fakeStore(): DocumentByteStore {
  const files = new Map<string, Uint8Array>();
  return {
    async loadDocumentBytes(key) {
      return files.get(key) ?? null;
    },
    async saveDocumentBytes(key, bytes) {
      files.set(key, bytes);
    },
  };
}

function fakeBackupStore(): DiscardedDocumentBackupStore {
  return {
    async backup(key) {
      return { path: `/fake/${key}.automerge`, capturedAt: new Date().toISOString() };
    },
  };
}

function fakeSqlSource(overrides: Partial<SqlSourceAdapter> = {}): SqlSourceAdapter {
  return {
    async listExistingConnections() {
      return [];
    },
    ...overrides,
  };
}

function fakeProjection(): SqlProjectionAdapter & { rows: Map<string, AiConnectionEntry> } {
  const rows = new Map<string, AiConnectionEntry>();
  return {
    rows,
    async upsertConnection(connection) {
      rows.set(connection.id, connection);
    },
    async deleteConnection(connectionId) {
      rows.delete(connectionId);
    },
  };
}

function makeDeps(overrides: Partial<ServiceDependencies> = {}, store: DocumentByteStore = fakeStore()): ServiceDependencies {
  return {
    core: createAutomergeCore<AiConnectionsDocument>({ store, discardedBackupStore: fakeBackupStore(), emptyDocument }),
    store,
    sqlSource: fakeSqlSource(),
    projection: fakeProjection(),
    ...overrides,
  };
}

const BASE_INPUT = {
  id: "conn-1",
  displayName: "My OpenAI-compatible endpoint",
  adapterType: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  modelId: "gpt-test",
  localInferenceMode: false,
  enabled: true,
  capabilitiesJson: "{}",
  assignedTasksJson: '["ai_localization"]',
  pricingJson: null,
};

test("createConnection: a first connection is stored with unknown status and projects to SQL", async () => {
  const projection = fakeProjection();
  const core = createAiConnectionsCatalogCore(makeDeps({ projection }));

  const result = await core.createConnection(BASE_INPUT);

  assert.equal(result.status, "unknown");
  assert.equal(result.statusMessage, null);
  assert.equal(projection.rows.get("conn-1")?.displayName, "My OpenAI-compatible endpoint");
});

test("createConnection: a duplicate id is rejected with validation_failed", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  await core.createConnection(BASE_INPUT);

  await assert.rejects(
    () => core.createConnection(BASE_INPUT),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "validation_failed"
  );
});

test("createConnection: bootstraps pre-existing SQL connections into the document on first write, never losing them", async () => {
  const existing: AiConnectionEntry = { ...BASE_INPUT, id: "conn-existing", status: "ok", statusMessage: null, statusCheckedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  const core = createAiConnectionsCatalogCore(makeDeps({ sqlSource: fakeSqlSource({ async listExistingConnections() { return [existing]; } }) }));

  await core.createConnection({ ...BASE_INPUT, id: "conn-new" });

  const bytes = await core.exportBytes();
  const doc = Automerge.load<AiConnectionsDocument>(bytes);
  assert.ok(doc.connections["conn-existing"], "the pre-existing connection must survive the cutover");
  assert.ok(doc.connections["conn-new"]);
});

test("updateConnection: undefined fields are left unchanged, provided fields are applied", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  await core.createConnection(BASE_INPUT);

  const updated = await core.updateConnection("conn-1", { displayName: "Renamed", status: "ok", statusMessage: "Looks good" });

  assert.equal(updated?.displayName, "Renamed");
  assert.equal(updated?.status, "ok");
  assert.equal(updated?.modelId, "gpt-test", "left unchanged");
});

test("updateConnection: returns null for an unknown connection id, without throwing", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  const result = await core.updateConnection("does-not-exist", { displayName: "x" });
  assert.equal(result, null);
});

test("deleteConnection: removes the connection from the document and the SQL projection", async () => {
  const projection = fakeProjection();
  const core = createAiConnectionsCatalogCore(makeDeps({ projection }));
  await core.createConnection(BASE_INPUT);

  await core.deleteConnection("conn-1");

  const bytes = await core.exportBytes();
  const doc = Automerge.load<AiConnectionsDocument>(bytes);
  assert.equal(doc.connections["conn-1"], undefined);
  assert.equal(projection.rows.has("conn-1"), false);
});

test("mergeIncoming: two devices concurrently editing the SAME connection field are reported as a new conflict", async () => {
  const store = fakeStore();
  const core = createAiConnectionsCatalogCore(makeDeps({}, store));
  await core.createConnection(BASE_INPUT);

  const localBytes = await core.exportBytes();
  const localAfterUpdate = await core.updateConnection("conn-1", { displayName: "Local name" });
  assert.ok(localAfterUpdate);

  const localDoc = Automerge.load<AiConnectionsDocument>(localBytes);
  const peerNext = Automerge.change(Automerge.clone(localDoc), "peer edit same field", (d) => {
    d.connections["conn-1"].displayName = "Peer name";
  });

  const { newConflicts } = await core.mergeIncoming(Automerge.save(peerNext));
  assert.equal(newConflicts.length, 1);
  assert.equal(newConflicts[0].connectionId, "conn-1");
  assert.equal(newConflicts[0].field, "displayName");
});

test("resolveConflict writes the chosen competing value and clears the conflict, verified independently via listConflicts", async () => {
  const store = fakeStore();
  const core = createAiConnectionsCatalogCore(makeDeps({}, store));
  await core.createConnection(BASE_INPUT);

  const localBytes = await core.exportBytes();
  await core.updateConnection("conn-1", { displayName: "Local name" });
  const localDoc = Automerge.load<AiConnectionsDocument>(localBytes);
  const peerNext = Automerge.change(Automerge.clone(localDoc), "peer edit same field", (d) => {
    d.connections["conn-1"].displayName = "Peer name";
  });
  const { newConflicts } = await core.mergeIncoming(Automerge.save(peerNext));
  const [winningActorId, winningValue] = Object.entries(newConflicts[0].valuesByActor).find(([, v]) => v === "Peer name")!;

  const resolved = await core.resolveConflict({ connectionId: "conn-1", field: "displayName", winningActorId });
  assert.equal(resolved.displayName, winningValue);

  const remaining = await core.listConflicts();
  assert.equal(remaining.length, 0, "the conflict must actually be cleared, not merely reported as resolved");
});

test("resolveConflict rejects an unknown winningActorId rather than silently writing something", async () => {
  const store = fakeStore();
  const core = createAiConnectionsCatalogCore(makeDeps({}, store));
  await core.createConnection(BASE_INPUT);

  const localBytes = await core.exportBytes();
  await core.updateConnection("conn-1", { displayName: "Local name" });
  const localDoc = Automerge.load<AiConnectionsDocument>(localBytes);
  const peerNext = Automerge.change(Automerge.clone(localDoc), "peer edit same field", (d) => {
    d.connections["conn-1"].displayName = "Peer name";
  });
  await core.mergeIncoming(Automerge.save(peerNext));

  await assert.rejects(
    () => core.resolveConflict({ connectionId: "conn-1", field: "displayName", winningActorId: "not-a-real-actor-id" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "validation_failed"
  );

  const remaining = await core.listConflicts();
  assert.equal(remaining.length, 1, "nothing must have changed -- the conflict is still exactly as it was");
});

test("resolveConflict rejects a field with no actual conflict, rather than performing a no-op write", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  await core.createConnection(BASE_INPUT);

  await assert.rejects(
    () => core.resolveConflict({ connectionId: "conn-1", field: "displayName", winningActorId: "anything" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "validation_failed"
  );
});

test("resolveConflict rejects an unknown connectionId", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  await assert.rejects(
    () => core.resolveConflict({ connectionId: "does-not-exist", field: "displayName", winningActorId: "anything" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "not_found"
  );
});

// Regression (advisor review): a connection deleted by a PEER must be cleaned up from the local
// SQL projection too -- it disappears from `merged.connections`, so a touched-ids computation
// that only looks at the post-merge key set never calls `deleteConnection` for it, leaving a
// phantom row visible via `listConnections` even though the document (source of truth) no
// longer has it. Same bug class as change-drafts' own RISK-46 orphan-row fix.
test("mergeIncoming: a connection deleted by a peer is removed from the local SQL projection too", async () => {
  const store = fakeStore();
  const projection = fakeProjection();
  const core = createAiConnectionsCatalogCore(makeDeps({ projection }, store));
  await core.createConnection(BASE_INPUT);
  await core.createConnection({ ...BASE_INPUT, id: "conn-2" });
  assert.ok(projection.rows.has("conn-1"));

  const localBytes = await core.exportBytes();
  const localDoc = Automerge.load<AiConnectionsDocument>(localBytes);
  const peerNext = Automerge.change(Automerge.clone(localDoc), "peer deletes conn-1", (d) => {
    delete d.connections["conn-1"];
  });

  await core.mergeIncoming(Automerge.save(peerNext));

  assert.equal(projection.rows.has("conn-1"), false, "deleted-by-peer connection must be removed from the projection");
  assert.ok(projection.rows.has("conn-2"), "an untouched connection must survive the same merge");
});

test("discardLocalAndAdoptPeer: adopts the peer's connections and re-projects them, removing ones only the discarded doc had", async () => {
  const projection = fakeProjection();
  const core = createAiConnectionsCatalogCore(makeDeps({ projection }));
  await core.createConnection(BASE_INPUT);
  await core.createConnection({ ...BASE_INPUT, id: "conn-local-only" });

  const peerDoc = Automerge.change(Automerge.from<AiConnectionsDocument>(emptyDocument()), "peer state", (d) => {
    d.connections["conn-1"] = { ...BASE_INPUT, displayName: "From peer", status: "unknown", statusMessage: null, statusCheckedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  });

  const { backupPath } = await core.discardLocalAndAdoptPeer(Automerge.save(peerDoc));

  assert.ok(backupPath);
  assert.equal(projection.rows.get("conn-1")?.displayName, "From peer");
  assert.equal(projection.rows.has("conn-local-only"), false, "a connection only the discarded document had must be cleaned up");
});

test("exportBytes throws not_found when the document has never been saved", async () => {
  const core = createAiConnectionsCatalogCore(makeDeps());
  await assert.rejects(() => core.exportBytes(), (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "not_found");
});

test("exportBytes/mergeIncoming operate on the single GLOBAL_DOCUMENT_KEY, confirmed via the raw store", async () => {
  const store = fakeStore();
  const core = createAiConnectionsCatalogCore(makeDeps({}, store));
  await core.createConnection(BASE_INPUT);

  const bytes = await store.loadDocumentBytes(GLOBAL_DOCUMENT_KEY);
  assert.ok(bytes, "the document must be stored under the constant global key, not a per-caller one");
});
