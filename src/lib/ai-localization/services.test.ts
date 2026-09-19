import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeSet } from "@/lib/changesets/contracts";
import type { LocalizationGenerationOutcome, LocalizationGenerationRequest, LocalizationProvider, StoredChannelRecord, StoredVideoRecord } from "./contracts";
import { DomainError } from "./contracts";
import { createAiLocalizationServices } from "./services";

function makeChannel(overrides: Partial<StoredChannelRecord> = {}): StoredChannelRecord {
  return {
    channelId: "UC_TEST",
    title: "Tropico Jazz",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: "user-1",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeVideo(overrides: Partial<StoredVideoRecord> = {}): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "Cats of the world",
    description: "A tour.",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: {},
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeFixture(videos: StoredVideoRecord[] = [makeVideo()]) {
  const channel = makeChannel();
  const channelStore = {
    async getChannel(channelId: string) {
      return channelId === channel.channelId ? channel : null;
    },
    async listVideosByChannel(channelId: string) {
      return channelId === channel.channelId ? videos : [];
    },
  };

  const persistedChangeSets: Array<{ channelId: string; source: ChangeSet["source"]; changes: unknown[] }> = [];
  let idCounter = 0;

  const changeSetServices = {
    async createChangeSetFromProposals(input: { channelId: string; source: ChangeSet["source"]; changes: unknown[] }) {
      persistedChangeSets.push(input);
      const now = new Date().toISOString();
      const cs: ChangeSet = {
        id: `cs-${persistedChangeSets.length}`,
        channelId: input.channelId,
        source: input.source,
        status: "in_review",
        importedFilename: null,
        schemaVersion: null,
        exportedAt: null,
        hasInvalid: false,
        hasConflicts: false,
        totalChanges: input.changes.length,
        pendingCount: input.changes.length,
        approvedCount: 0,
        rejectedCount: 0,
        conflictCount: 0,
        invalidCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      return cs;
    },
  };

  const logger = { info() {}, error() {} };

  const profiles = new Map<string, { channelId: string; version: number; targetAudience: string | null; toneNotes: string | null; terminologyNotes: string | null; titleConstraints: string | null; descriptionConstraints: string | null; updatedAt: Date }>();
  const profileStore = {
    async getProfile(channelId: string) {
      return profiles.get(channelId) ?? null;
    },
    async saveProfile(input: { channelId: string; targetAudience?: string | null; toneNotes?: string | null; terminologyNotes?: string | null; titleConstraints?: string | null; descriptionConstraints?: string | null }) {
      const existing = profiles.get(input.channelId);
      const next = {
        channelId: input.channelId,
        version: existing ? existing.version + 1 : 1,
        targetAudience: input.targetAudience !== undefined ? input.targetAudience : (existing?.targetAudience ?? null),
        toneNotes: input.toneNotes !== undefined ? input.toneNotes : (existing?.toneNotes ?? null),
        terminologyNotes: input.terminologyNotes !== undefined ? input.terminologyNotes : (existing?.terminologyNotes ?? null),
        titleConstraints: input.titleConstraints !== undefined ? input.titleConstraints : (existing?.titleConstraints ?? null),
        descriptionConstraints: input.descriptionConstraints !== undefined ? input.descriptionConstraints : (existing?.descriptionConstraints ?? null),
        updatedAt: new Date(),
      };
      profiles.set(input.channelId, next);
      return next;
    },
  };

  const provenanceRecords = new Map<string, { id: string; changeSetId: string; channelId: string; profileVersion: number | null; effectiveContextJson: string | null; createdAt: Date }>();
  const provenanceStore = {
    async create(input: { id: string; changeSetId: string; channelId: string; profileVersion: number | null; effectiveContextJson: string | null }) {
      provenanceRecords.set(input.changeSetId, { ...input, createdAt: new Date() });
    },
    async getByChangeSetId(changeSetId: string) {
      return provenanceRecords.get(changeSetId) ?? null;
    },
  };

  function build(
    provider: LocalizationProvider,
    extraDeps: {
      resolveConnectionProvider?: (connectionId: string) => Promise<LocalizationProvider>;
      assertDeviceAvailable?: () => Promise<void>;
    } = {}
  ) {
    return createAiLocalizationServices({
      channelStore,
      resolveProvider: () => provider,
      defaultProviderName: "mock",
      changeSetServices,
      profileStore,
      provenanceStore,
      idGenerator: () => `id-${++idCounter}`,
      logger,
      ...extraDeps,
    });
  }

  return { build, persistedChangeSets, profileStore, provenanceStore };
}

function fixedProvider(fn: (req: LocalizationGenerationRequest) => Promise<LocalizationGenerationOutcome> | LocalizationGenerationOutcome): LocalizationProvider {
  let calls = 0;
  const calledWith: LocalizationGenerationRequest[] = [];
  const provider: LocalizationProvider & { calls: number; calledWith: LocalizationGenerationRequest[] } = {
    name: "fixture",
    get calls() {
      return calls;
    },
    calledWith,
    async generate(req) {
      calls += 1;
      calledWith.push(req);
      return fn(req);
    },
  };
  return provider;
}

// AC-GEN-01
test("AC-GEN-01: generating for a video with no existing target-language localization classifies as add", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider((req) => ({
    status: "ok",
    title: `[${req.targetLanguage.toUpperCase()}] ${req.sourceTitle}`,
    description: `[${req.targetLanguage.toUpperCase()}] ${req.sourceDescription}`,
  }));
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(result.results.length, 1);
  const [target] = result.results;
  assert.equal(target.providerError, null);
  assert.equal(target.fields.length, 2);
  for (const field of target.fields) {
    assert.equal(field.changeType, "add");
    assert.equal(field.validationStatus, "valid");
    assert.equal(field.baselineValue, "");
  }
  const title = target.fields.find((f) => f.field === "title")!;
  assert.equal(title.proposedValue, "[ES] Cats of the world");
});

// AC-GEN-02
test("AC-GEN-02: generating against an existing different localization classifies as modify", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "Gatos viejos", description: "Vieja desc." } } });
  const { build } = makeFixture([video]);
  const provider = fixedProvider(() => ({ status: "ok", title: "Gatos del mundo", description: "Una gira." }));
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  const [target] = result.results;
  for (const field of target.fields) {
    assert.equal(field.changeType, "modify");
  }
  assert.equal(target.fields.find((f) => f.field === "title")!.baselineValue, "Gatos viejos");
  assert.equal(target.fields.find((f) => f.field === "description")!.baselineValue, "Vieja desc.");
});

// AC-GEN-03
test("AC-GEN-03: a proposal identical to the current remote value classifies as unchanged", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "Ya traducido", description: "Old desc" } } });
  const { build } = makeFixture([video]);
  const provider = fixedProvider(() => ({ status: "ok", title: "Ya traducido", description: "New desc" }));
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  const [target] = result.results;
  assert.equal(target.fields.find((f) => f.field === "title")!.changeType, "unchanged");
  assert.notEqual(target.fields.find((f) => f.field === "description")!.changeType, "unchanged");
});

// AC-GEN-04
test("AC-GEN-04: an invalid target language is rejected before the provider is called, without blocking other targets", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & { calls: number };
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["!!!", "es"] });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].language, "!!!");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].language, "es");
  assert.equal(provider.calls, 1);
});

// AC-GEN-05
test("AC-GEN-05: a videoId outside this channel's synchronized data is rejected, without blocking other targets", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" }));
  const services = build(provider);

  const result = await services.generateProposals({
    channelId: "UC_TEST",
    videoIds: ["v1", "v-unknown"],
    targetLanguages: ["es"],
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].videoId, "v-unknown");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].videoId, "v1");
});

// AC-GEN-06
test("AC-GEN-06: duplicate (videoId, language) targets are deduplicated; provider called once", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & { calls: number };
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1", "v1"], targetLanguages: ["es"] });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Duplicate/);
  assert.equal(result.results.length, 1);
  assert.equal(provider.calls, 1);
});

// AC-GEN-07
test("AC-GEN-07: a provider failure for one target does not abort or affect sibling targets", async () => {
  const { build } = makeFixture([makeVideo({ videoId: "v1" }), makeVideo({ videoId: "v2" })]);
  const provider = fixedProvider((req) => {
    if (req.videoId === "v1") return { status: "error", message: "rate_limited" };
    return { status: "ok", title: "[ES] " + req.sourceTitle, description: "[ES] " + req.sourceDescription };
  });
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1", "v2"], targetLanguages: ["es"] });

  const v1 = result.results.find((r) => r.videoId === "v1")!;
  const v2 = result.results.find((r) => r.videoId === "v2")!;
  assert.equal(v1.providerError, "rate_limited");
  assert.equal(v1.fields.length, 0);
  assert.equal(v2.providerError, null);
  assert.equal(v2.fields.length, 2);
});

// INV-6.2 (docs/acceptance/PHASE_6_ACCEPTANCE.md): a provider isolation guarantee is
// stated in terms of "provider failure", not merely the { status: "error" } outcome
// shape. A real provider (network client, SDK) can throw synchronously or reject its
// promise instead of resolving to an error outcome (timeout, thrown exception, bug).
// Independent review: this exact case has no covering acceptance scenario or test.
test("INV-6.2 (independent review addition): a provider that throws for one target does not abort or lose sibling targets' results", async () => {
  const { build } = makeFixture([makeVideo({ videoId: "v1" }), makeVideo({ videoId: "v2" })]);
  const provider = fixedProvider((req) => {
    if (req.videoId === "v1") {
      throw new Error("boom: unexpected provider exception");
    }
    return { status: "ok", title: "[ES] " + req.sourceTitle, description: "[ES] " + req.sourceDescription };
  });
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1", "v2"], targetLanguages: ["es"] });

  const v1 = result.results.find((r) => r.videoId === "v1")!;
  const v2 = result.results.find((r) => r.videoId === "v2")!;
  assert.ok(v1, "v1's result must still be present even though its provider call threw");
  assert.match(v1.providerError ?? "", /boom/);
  assert.equal(v1.fields.length, 0);
  assert.ok(v2, "v2 must still be generated even though v1's provider call threw first");
  assert.equal(v2.providerError, null);
  assert.equal(v2.fields.length, 2);
});

// AC-GEN-08
test("AC-GEN-08: an empty generated field is flagged invalid, never silently accepted or dropped", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "", description: "A valid tour." }));
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  const [target] = result.results;
  const title = target.fields.find((f) => f.field === "title")!;
  const description = target.fields.find((f) => f.field === "description")!;
  assert.equal(title.validationStatus, "invalid");
  assert.match(title.validationError ?? "", /empty/);
  assert.equal(description.validationStatus, "valid");
});

// AC-GEN-09
test("AC-GEN-09: an oversized generated title is flagged invalid using the 100-character limit", async () => {
  const { build } = makeFixture();
  const oversized = "x".repeat(101);
  const provider = fixedProvider(() => ({ status: "ok", title: oversized, description: "Valid" }));
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  const title = result.results[0].fields.find((f) => f.field === "title")!;
  assert.equal(title.validationStatus, "invalid");
  assert.match(title.validationError ?? "", /100/);
  assert.match(title.validationError ?? "", /101/);
});

// AC-CONTEXT-01
test("AC-CONTEXT-01: optional editorial context is forwarded to the provider unchanged, never persisted", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & {
    calledWith: LocalizationGenerationRequest[];
  };
  const services = build(provider);

  const editorialBrief = { targetAudience: "Beginners", toneNotes: "Playful" };
  await services.generateProposals({
    channelId: "UC_TEST",
    videoIds: ["v1"],
    targetLanguages: ["es"],
    editorialBrief,
  });

  assert.equal(provider.calledWith.length, 1);
  assert.deepEqual(provider.calledWith[0].editorialBrief, editorialBrief);
});

// AC-CONTEXT-02
test("AC-CONTEXT-02: omitting editorial context generates normally with no hidden default injected", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & {
    calledWith: LocalizationGenerationRequest[];
  };
  const services = build(provider);

  const result = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(result.results.length, 1);
  assert.equal(provider.calledWith.length, 1);
  assert.equal("editorialBrief" in provider.calledWith[0], false);
});

// AC-CS-01
test("AC-CS-01: creating a change set from reviewed proposals persists only requested actionable fields, source ai_localization", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  const changeSet = await services.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "Gatos del mundo" }],
  });

  assert.equal(changeSet.source, "ai_localization");
  assert.equal(persistedChangeSets.length, 1);
  assert.equal(persistedChangeSets[0].source, "ai_localization");
  assert.equal(persistedChangeSets[0].changes.length, 1);
  const change = persistedChangeSets[0].changes[0] as { field: string; changeType: string; approvalStatus?: string };
  assert.equal(change.field, "title");
  assert.equal(change.changeType, "add");
});

// AC-CS-02
test("AC-CS-02: omitting a field from a reviewed proposal never creates a change for it (no deletion)", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "Gatos viejos", description: "Vieja desc." } } });
  const { build, persistedChangeSets } = makeFixture([video]);
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await services.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "Gatos del mundo" }],
  });

  const changes = persistedChangeSets[0].changes as Array<{ field: string }>;
  assert.equal(changes.length, 1);
  assert.ok(!changes.some((c) => c.field === "description"));
});

// AC-CS-03
test("AC-CS-03: a human-edited proposal is what gets persisted, and the provider is never called during change-set creation", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "[ES] Cats of the world", description: "[ES] A tour." })) as LocalizationProvider & { calls: number };
  const services = build(provider);

  await services.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "Los Gatos del Mundo" }],
  });

  const change = persistedChangeSets[0].changes[0] as { proposedValue: string };
  assert.equal(change.proposedValue, "Los Gatos del Mundo");
  assert.equal(provider.calls, 0);
});

// AC-CS-04
test("AC-CS-04: a duplicate (videoId, language) pair in submitted proposals is rejected before persistence", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await assert.rejects(
    services.createChangeSetFromGeneration({
      channelId: "UC_TEST",
      proposals: [
        { videoId: "v1", language: "es", title: "A" },
        { videoId: "v1", language: "es", title: "B" },
      ],
    }),
    DomainError
  );
  assert.equal(persistedChangeSets.length, 0);
});

// AC-CS-05
test("AC-CS-05: a proposal for a video outside this channel's synchronized data is rejected before persistence", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await assert.rejects(
    services.createChangeSetFromGeneration({
      channelId: "UC_TEST",
      proposals: [{ videoId: "v-unknown", language: "es", title: "A" }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === "not_found"
  );
  assert.equal(persistedChangeSets.length, 0);
});

// AC-CS-06
test("AC-CS-06: submitting only unchanged proposals produces no change set", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "Ya traducido", description: "Old" } } });
  const { build, persistedChangeSets } = makeFixture([video]);
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await assert.rejects(
    services.createChangeSetFromGeneration({
      channelId: "UC_TEST",
      proposals: [{ videoId: "v1", language: "es", title: "Ya traducido" }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === "generation_no_proposals"
  );
  assert.equal(persistedChangeSets.length, 0);
});

// AC-CS-07 (added post-implementation, independent review: this exact check had no
// dedicated test and, when disabled, every other test in this file still passed)
test("AC-CS-07: an invalid target language submitted directly to change-set creation is rejected before persistence", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await assert.rejects(
    services.createChangeSetFromGeneration({
      channelId: "UC_TEST",
      proposals: [{ videoId: "v1", language: "!!!", title: "A" }],
    }),
    (err: unknown) => err instanceof DomainError && err.code === "generation_invalid_target_language"
  );
  assert.equal(persistedChangeSets.length, 0);
});

// AC-APPROVAL-02
test("AC-APPROVAL-02: every persisted change starts pending, never auto-approved", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })));

  await services.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "Gatos del mundo" }],
  });

  // The persisted change objects passed to changeSetServices carry no approvalStatus
  // field at all (createChangeSetFromProposals/changesets always initializes new
  // changes to "pending" itself) -- assert this module never attempts to set one.
  const change = persistedChangeSets[0].changes[0] as Record<string, unknown>;
  assert.equal("approvalStatus" in change, false);
});

// RISK-30 (docs/TECHNICAL_DEBT.md): src/proxy.ts exempts this route from the device-
// availability/recovery-mode gate on the rationale "no local writes, never calls YouTube" --
// true, but incomplete, since a real connection still makes a genuine outbound call to an
// external AI provider. The gate must be enforced here, on the real-connection path only.
test("RISK-30: a real-connection generation checks device availability before resolving the provider", async () => {
  const { build } = makeFixture();
  let checked = false;
  let resolveConnectionProviderCalled = false;
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })), {
    assertDeviceAvailable: async () => {
      checked = true;
    },
    resolveConnectionProvider: async () => {
      resolveConnectionProviderCalled = true;
      return fixedProvider(() => ({ status: "ok", title: "x", description: "y" }));
    },
  });

  await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"], connectionId: "conn-1" });

  assert.equal(checked, true);
  assert.equal(resolveConnectionProviderCalled, true);
});

test("RISK-30: a real-connection generation fails closed if the device is not available, before ever resolving the provider", async () => {
  const { build } = makeFixture();
  let resolveConnectionProviderCalled = false;
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })), {
    assertDeviceAvailable: async () => {
      throw new Error("device_in_recovery_mode");
    },
    resolveConnectionProvider: async () => {
      resolveConnectionProviderCalled = true;
      return fixedProvider(() => ({ status: "ok", title: "x", description: "y" }));
    },
  });

  await assert.rejects(
    () => services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"], connectionId: "conn-1" }),
    /device_in_recovery_mode/
  );
  assert.equal(resolveConnectionProviderCalled, false);
});

// (independent review, second cycle): the catch wrapping generateProposals previously
// rewrapped every non-DomainError -- including a real OperationLockError/RecoveryModeError
// thrown by assertDeviceAvailable -- into a generic "generation_failed" DomainError, discarding
// the specific code/details proxy.ts/mcp/server.ts/the CLI all rely on via instanceof checks.
test("RISK-30 (independent review, second cycle): a real OperationLockError/RecoveryModeError from assertDeviceAvailable is never rewrapped into a generic DomainError", async () => {
  const { build } = makeFixture();
  const { OperationLockError } = await import("@/lib/operation-lock");
  const lockError = new OperationLockError({
    heldBy: { id: "singleton", operationType: "export", holderPid: 999, acquiredAt: new Date().toISOString() },
    stale: false,
  });
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })), {
    assertDeviceAvailable: async () => {
      throw lockError;
    },
    resolveConnectionProvider: async () => fixedProvider(() => ({ status: "ok", title: "x", description: "y" })),
  });

  await assert.rejects(
    () => services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"], connectionId: "conn-1" }),
    (error: unknown) => error === lockError
  );
});

test("RISK-30: the mock provider path (no connectionId) never calls the device-availability check", async () => {
  const { build } = makeFixture();
  let checked = false;
  const services = build(fixedProvider(() => ({ status: "ok", title: "x", description: "y" })), {
    assertDeviceAvailable: async () => {
      checked = true;
    },
  });

  await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(checked, false);
});
