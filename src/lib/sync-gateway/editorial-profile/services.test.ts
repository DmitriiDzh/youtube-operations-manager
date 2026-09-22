import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { createAutomergeCore } from "../automerge-core";
import { emptyProfile, createEditorialProfileCore, type ServiceDependencies } from "./services";
import type { EditorialProfileDocument } from "./contracts";
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
    async getExistingProfile() {
      return null;
    },
    ...overrides,
  };
}

function fakeProjection(): SqlProjectionAdapter & { projected: Map<string, EditorialProfileDocument> } {
  const projected = new Map<string, EditorialProfileDocument>();
  return {
    projected,
    async upsertProfile(profile) {
      projected.set(profile.channelId, profile);
    },
  };
}

function makeDeps(overrides: Partial<ServiceDependencies> = {}, store: DocumentByteStore = fakeStore()): ServiceDependencies {
  return {
    core: createAutomergeCore<EditorialProfileDocument>({
      store,
      discardedBackupStore: fakeBackupStore(),
      emptyDocument: emptyProfile,
    }),
    sqlSource: fakeSqlSource(),
    projection: fakeProjection(),
    ...overrides,
  };
}

test("saveProfile: a first save on a fresh channel starts at version 1 and projects to SQL", async () => {
  const projection = fakeProjection();
  const core = createEditorialProfileCore(makeDeps({ projection }));

  const result = await core.saveProfile({ channelId: "UC_1", targetAudience: "Jazz fans" });

  assert.equal(result.version, 1);
  assert.equal(result.targetAudience, "Jazz fans");
  assert.equal(projection.projected.get("UC_1")?.targetAudience, "Jazz fans");
});

test("saveProfile: an undefined field leaves the stored value unchanged, null explicitly clears it", async () => {
  const store = fakeStore();
  const deps = makeDeps({}, store);
  const core = createEditorialProfileCore(deps);

  await core.saveProfile({ channelId: "UC_1", targetAudience: "Jazz fans", toneNotes: "Warm" });
  const second = await core.saveProfile({ channelId: "UC_1", toneNotes: null });

  assert.equal(second.version, 2);
  assert.equal(second.targetAudience, "Jazz fans", "left unchanged by the second, undefined call");
  assert.equal(second.toneNotes, null, "explicitly cleared by the second call");
});

test("saveProfile: bootstraps from a pre-existing SQL profile on the very first save, never losing it", async () => {
  const core = createEditorialProfileCore(
    makeDeps({
      sqlSource: fakeSqlSource({
        async getExistingProfile(channelId) {
          return {
            channelId,
            version: 5,
            targetAudience: "Existing audience",
            toneNotes: "Existing tone",
            terminologyNotes: null,
            titleConstraints: null,
            descriptionConstraints: null,
            updatedAt: new Date(0).toISOString(),
          };
        },
      }),
    })
  );

  const result = await core.saveProfile({ channelId: "UC_1", toneNotes: "New tone" });

  assert.equal(result.version, 6, "bumped from the bootstrapped version 5, not from scratch");
  assert.equal(result.targetAudience, "Existing audience", "preserved from the pre-existing SQL row");
  assert.equal(result.toneNotes, "New tone");
});

test("exportBytes throws not_found for a channel with no document yet", async () => {
  const core = createEditorialProfileCore(makeDeps());
  await assert.rejects(
    () => core.exportBytes("UC_never_saved"),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "not_found"
  );
});

test("mergeIncoming: a device with no local document adopts the incoming profile directly", async () => {
  const core = createEditorialProfileCore(makeDeps());
  const peerDoc = Automerge.change(Automerge.from<EditorialProfileDocument>(emptyProfile("UC_1")), "peer save", (d) => {
    d.targetAudience = "From peer";
    d.version = 1;
  });

  const { newConflicts } = await core.mergeIncoming({ channelId: "UC_1", incomingBytes: Automerge.save(peerDoc) });
  assert.deepEqual(newConflicts, []);

  const exported = Automerge.load<EditorialProfileDocument>(await core.exportBytes("UC_1"));
  assert.equal(exported.targetAudience, "From peer");
});

test("mergeIncoming: concurrent edits to the SAME field on two devices are reported as a new conflict", async () => {
  const store = fakeStore();
  const core = createEditorialProfileCore(makeDeps({}, store));

  // Establish real shared history first.
  const origin = Automerge.from<EditorialProfileDocument>(emptyProfile("UC_1"));
  const { merged: adopted } = await createAutomergeCore<EditorialProfileDocument>({
    store,
    discardedBackupStore: fakeBackupStore(),
    emptyDocument: emptyProfile,
  }).mergeIncoming("UC_1", Automerge.save(origin), () => []);
  await store.saveDocumentBytes("UC_1", Automerge.save(adopted));

  await core.saveProfile({ channelId: "UC_1", toneNotes: "Local tone" });

  const peerNext = Automerge.change(Automerge.clone(adopted), "peer edit same field", (d) => {
    d.toneNotes = "Peer tone";
  });

  const { newConflicts } = await core.mergeIncoming({ channelId: "UC_1", incomingBytes: Automerge.save(peerNext) });
  assert.equal(newConflicts.length, 1);
  assert.equal(newConflicts[0].field, "toneNotes");
});

test("discardLocalAndAdoptPeer: adopts the peer's document and re-projects it to SQL", async () => {
  const projection = fakeProjection();
  const core = createEditorialProfileCore(makeDeps({ projection }));

  await core.saveProfile({ channelId: "UC_1", targetAudience: "Local" });

  const peerDoc = Automerge.from<EditorialProfileDocument>({ ...emptyProfile("UC_1"), version: 1, targetAudience: "Peer" });
  const { backupPath } = await core.discardLocalAndAdoptPeer({ channelId: "UC_1", incomingBytes: Automerge.save(peerDoc) });

  assert.ok(backupPath);
  assert.equal(projection.projected.get("UC_1")?.targetAudience, "Peer");
});
