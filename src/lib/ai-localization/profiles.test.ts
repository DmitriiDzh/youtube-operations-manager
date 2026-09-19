import assert from "node:assert/strict";
import test from "node:test";
import type { ChangeSet } from "@/lib/changesets/contracts";
import type { LocalizationGenerationOutcome, LocalizationGenerationRequest, LocalizationProvider, StoredChannelRecord, StoredVideoRecord } from "./contracts";
import { DomainError } from "./contracts";
import { createAiLocalizationServices } from "./services";

type StoredProfile = {
  channelId: string;
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: Date;
};

function makeChannel(channelId: string): StoredChannelRecord {
  return {
    channelId,
    title: `Channel ${channelId}`,
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${channelId}`,
    connectedUserId: "user-1",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function makeVideo(channelId: string): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId,
    title: "Sample video",
    description: "Sample description.",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: {},
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
  };
}

function makeFixture(channelIds: string[] = ["UC_TEST"]) {
  const channels = new Map(channelIds.map((id) => [id, makeChannel(id)]));
  const videos = new Map(channelIds.map((id) => [id, [makeVideo(id)]]));

  const channelStore = {
    async getChannel(channelId: string) {
      return channels.get(channelId) ?? null;
    },
    async listVideosByChannel(channelId: string) {
      return videos.get(channelId) ?? [];
    },
  };

  const persistedChangeSets: Array<{ channelId: string; source: ChangeSet["source"]; changes: unknown[] }> = [];
  let csCounter = 0;
  const changeSetServices = {
    async createChangeSetFromProposals(input: { channelId: string; source: ChangeSet["source"]; changes: unknown[] }) {
      persistedChangeSets.push(input);
      const now = new Date().toISOString();
      const cs: ChangeSet = {
        id: `cs-${++csCounter}`,
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

  const profiles = new Map<string, StoredProfile>();
  const profileStore = {
    async getProfile(channelId: string) {
      return profiles.get(channelId) ?? null;
    },
    async saveProfile(input: {
      channelId: string;
      targetAudience?: string | null;
      toneNotes?: string | null;
      terminologyNotes?: string | null;
      titleConstraints?: string | null;
      descriptionConstraints?: string | null;
    }) {
      const existing = profiles.get(input.channelId);
      const next: StoredProfile = {
        channelId: input.channelId,
        version: existing ? existing.version + 1 : 1,
        targetAudience: input.targetAudience !== undefined ? input.targetAudience : (existing?.targetAudience ?? null),
        toneNotes: input.toneNotes !== undefined ? input.toneNotes : (existing?.toneNotes ?? null),
        terminologyNotes: input.terminologyNotes !== undefined ? input.terminologyNotes : (existing?.terminologyNotes ?? null),
        titleConstraints: input.titleConstraints !== undefined ? input.titleConstraints : (existing?.titleConstraints ?? null),
        descriptionConstraints:
          input.descriptionConstraints !== undefined ? input.descriptionConstraints : (existing?.descriptionConstraints ?? null),
        updatedAt: new Date(),
      };
      profiles.set(input.channelId, next);
      return next;
    },
  };

  const provenanceRecords = new Map<
    string,
    { id: string; changeSetId: string; channelId: string; profileVersion: number | null; effectiveContextJson: string | null; createdAt: Date }
  >();
  let provenanceCreateCount = 0;
  const provenanceStore = {
    async create(input: { id: string; changeSetId: string; channelId: string; profileVersion: number | null; effectiveContextJson: string | null }) {
      provenanceCreateCount += 1;
      provenanceRecords.set(input.changeSetId, { ...input, createdAt: new Date() });
    },
    async getByChangeSetId(changeSetId: string) {
      return provenanceRecords.get(changeSetId) ?? null;
    },
  };

  const logger = { info() {}, error() {} };
  let idCounter = 0;

  function build(provider?: LocalizationProvider) {
    return createAiLocalizationServices({
      channelStore,
      resolveProvider: () => provider ?? fixedProvider(() => ({ status: "ok", title: "T", description: "D" })),
      defaultProviderName: "mock",
      changeSetServices,
      profileStore,
      provenanceStore,
      idGenerator: () => `id-${++idCounter}`,
      logger,
    });
  }

  return { build, persistedChangeSets, provenanceCreateCount: () => provenanceCreateCount };
}

function fixedProvider(fn: (req: LocalizationGenerationRequest) => Promise<LocalizationGenerationOutcome> | LocalizationGenerationOutcome): LocalizationProvider {
  const calledWith: LocalizationGenerationRequest[] = [];
  return {
    name: "fixture",
    calledWith,
    async generate(req) {
      calledWith.push(req);
      return fn(req);
    },
  } as LocalizationProvider & { calledWith: LocalizationGenerationRequest[] };
}

// AC-PROFILE-01
test("AC-PROFILE-01: a channel with no saved profile generates normally with no invented default content", async () => {
  const { build } = makeFixture();
  const services = build();

  const profile = await services.getEditorialProfile({ channelId: "UC_TEST" });
  assert.equal(profile, null);

  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & {
    calledWith: LocalizationGenerationRequest[];
  };
  const servicesWithProvider = createAiLocalizationServicesWithProvider(build, provider);
  const result = await servicesWithProvider.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });

  assert.equal(result.results.length, 1);
  assert.equal(provider.calledWith.length, 1);
  assert.equal("editorialBrief" in provider.calledWith[0], false);
  assert.deepEqual(result.generationContext, { profileVersion: null, effectiveContext: null });
});

function createAiLocalizationServicesWithProvider(_build: (p?: LocalizationProvider) => ReturnType<typeof createAiLocalizationServices>, provider: LocalizationProvider) {
  return _build(provider);
}

// AC-PROFILE-02
test("AC-PROFILE-02: saving a profile for the first time creates version 1", async () => {
  const { build } = makeFixture();
  const services = build();

  const profile = await services.saveEditorialProfile({ channelId: "UC_TEST", targetAudience: "Beginners", toneNotes: "Playful" });

  assert.equal(profile.version, 1);
  assert.equal(profile.targetAudience, "Beginners");
  assert.equal(profile.toneNotes, "Playful");
  assert.equal(profile.terminologyNotes, null);
  assert.equal(profile.titleConstraints, null);
  assert.equal(profile.descriptionConstraints, null);
  assert.equal(typeof profile.updatedAt, "string");
});

// AC-PROFILE-03
test("AC-PROFILE-03: editing a profile increments version; omitted fields persist, explicit null clears", async () => {
  const { build } = makeFixture();
  const services = build();

  await services.saveEditorialProfile({
    channelId: "UC_TEST",
    targetAudience: "Beginners",
    toneNotes: "Formal",
    terminologyNotes: "Use simple words",
  });

  const updated = await services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Playful", targetAudience: null });

  assert.equal(updated.version, 2);
  assert.equal(updated.toneNotes, "Playful");
  assert.equal(updated.targetAudience, null);
  assert.equal(updated.terminologyNotes, "Use simple words"); // omitted -> unchanged
});

// AC-PROFILE-04
test("AC-PROFILE-04: two channels' profiles are fully isolated", async () => {
  const { build } = makeFixture(["UC_A", "UC_B"]);
  const services = build();

  await services.saveEditorialProfile({ channelId: "UC_A", targetAudience: "Audience A" });
  await services.saveEditorialProfile({ channelId: "UC_B", targetAudience: "Audience B" });

  const profileA = await services.getEditorialProfile({ channelId: "UC_A" });
  const profileB = await services.getEditorialProfile({ channelId: "UC_B" });

  assert.equal(profileA!.targetAudience, "Audience A");
  assert.equal(profileB!.targetAudience, "Audience B");
});

// AC-PROFILE-05
test("AC-PROFILE-05: a per-request editorialBrief field overrides the saved profile's same field", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & {
    calledWith: LocalizationGenerationRequest[];
  };
  // `build()` closes over one shared set of fixture stores, so a profile saved
  // through one `build(...)` call is visible to another built from the same fixture.
  const services = createAiLocalizationServicesWithProvider(build, provider);

  await services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Formal" });
  await services.generateProposals({
    channelId: "UC_TEST",
    videoIds: ["v1"],
    targetLanguages: ["es"],
    editorialBrief: { toneNotes: "Playful" },
  });

  assert.equal(provider.calledWith[0].editorialBrief?.toneNotes, "Playful");
});

// AC-PROFILE-06
test("AC-PROFILE-06: fields merge independently -- a profile-only field survives alongside a request override of a different field", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" })) as LocalizationProvider & {
    calledWith: LocalizationGenerationRequest[];
  };
  const services = createAiLocalizationServicesWithProvider(build, provider);

  await services.saveEditorialProfile({ channelId: "UC_TEST", targetAudience: "Beginners", toneNotes: "Formal" });
  await services.generateProposals({
    channelId: "UC_TEST",
    videoIds: ["v1"],
    targetLanguages: ["es"],
    editorialBrief: { toneNotes: "Playful" },
  });

  assert.equal(provider.calledWith[0].editorialBrief?.targetAudience, "Beginners");
  assert.equal(provider.calledWith[0].editorialBrief?.toneNotes, "Playful");
});

// AC-PROFILE-07
test("AC-PROFILE-07: malformed profile data is rejected before persistence", async () => {
  const { build } = makeFixture();
  const services = build();

  await assert.rejects(
    services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "" }),
    (err: unknown) => err instanceof DomainError && err.code === "validation_failed"
  );
  await assert.rejects(
    services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "x".repeat(2001) }),
    (err: unknown) => err instanceof DomainError && err.code === "validation_failed"
  );

  const profile = await services.getEditorialProfile({ channelId: "UC_TEST" });
  assert.equal(profile, null);
});

// AC-PROFILE-08
test("AC-PROFILE-08: a Change Set's recorded provenance survives a later edit to the profile", async () => {
  const { build } = makeFixture();
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" }));
  const services = createAiLocalizationServicesWithProvider(build, provider);

  await services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Formal" });
  const generation = await services.generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] });
  assert.equal(generation.generationContext.profileVersion, 1);
  assert.equal(generation.generationContext.effectiveContext?.toneNotes, "Formal");

  const changeSet = await services.createChangeSetFromGeneration({
    channelId: "UC_TEST",
    proposals: [{ videoId: "v1", language: "es", title: "T" }],
    provenance: generation.generationContext,
  });

  await services.saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Playful" });

  const provenance = await services.getGenerationProvenance({ channelId: "UC_TEST", changeSetId: changeSet.id });
  assert.equal(provenance?.profileVersion, 1);
  assert.equal(provenance?.effectiveContext?.toneNotes, "Formal");

  const liveProfile = await services.getEditorialProfile({ channelId: "UC_TEST" });
  assert.equal(liveProfile?.version, 2);
  assert.equal(liveProfile?.toneNotes, "Playful");
});

// AC-PROFILE-09
test("AC-PROFILE-09: provenance retrieval is channel-scoped", async () => {
  const { build } = makeFixture(["UC_A", "UC_B"]);
  const provider = fixedProvider(() => ({ status: "ok", title: "T", description: "D" }));
  const services = createAiLocalizationServicesWithProvider(build, provider);

  const generation = await services.generateProposals({ channelId: "UC_A", videoIds: ["v1"], targetLanguages: ["es"] });
  const changeSet = await services.createChangeSetFromGeneration({
    channelId: "UC_A",
    proposals: [{ videoId: "v1", language: "es", title: "T" }],
    provenance: generation.generationContext,
  });

  const crossChannel = await services.getGenerationProvenance({ channelId: "UC_B", changeSetId: changeSet.id });
  assert.equal(crossChannel, null);

  const sameChannel = await services.getGenerationProvenance({ channelId: "UC_A", changeSetId: changeSet.id });
  assert.notEqual(sameChannel, null);
});

// AC-PROFILE-10
test("AC-PROFILE-10: saving a profile never persists a Change or creates a Change Set", async () => {
  const { build, persistedChangeSets } = makeFixture();
  const services = build();

  await services.saveEditorialProfile({ channelId: "UC_TEST", targetAudience: "Beginners" });

  assert.equal(persistedChangeSets.length, 0);
});
