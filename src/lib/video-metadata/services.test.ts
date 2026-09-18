import assert from "node:assert/strict";
import test from "node:test";
import type {
  MetadataDraft,
  ResolvedCredentials,
  TranscriptResult,
  VideoMetadataItem,
} from "./contracts";
import { DomainError } from "./contracts";
import { createVideoMetadataServices, type ServiceDependencies } from "./services";

function makeCredentials(): ResolvedCredentials {
  return {
    credentialRef: { userId: "user-1" },
    accessToken: "access-token",
    refreshToken: "refresh-token",
    scopeSet: new Set(["scope-read", "scope-write"]),
  };
}

function makeVideo(): VideoMetadataItem {
  return {
    videoId: "video-1",
    title: "Original title",
    description: "Original description",
    publishedAt: "2024-01-01T00:00:00Z",
  };
}

function makeDraft(): MetadataDraft {
  return {
    finalTitle: "Final title",
    description: "Final description",
    promptVersion: "v1",
  };
}

type ServiceDependencyOverrides = {
  authResolver?: Partial<ServiceDependencies["authResolver"]>;
  youtubeApi?: Partial<ServiceDependencies["youtubeApi"]>;
  transcriptProvider?: Partial<ServiceDependencies["transcriptProvider"]>;
  metadataGenerator?: Partial<ServiceDependencies["metadataGenerator"]>;
  logger?: Partial<ServiceDependencies["logger"]>;
  writeContext?: Partial<ServiceDependencies["writeContext"]>;
  channelSelectionStore?: Partial<ServiceDependencies["channelSelectionStore"]>;
};

function makeDeps(overrides?: ServiceDependencyOverrides): ServiceDependencies {
  const credentials = makeCredentials();
  const video = makeVideo();
  const transcript: TranscriptResult = { status: "available", text: "transcript" };
  const draft = makeDraft();
  const metadataContext = {
    snippet: {
      title: "Original title",
      description: "Original description",
      categoryId: "22",
      defaultLanguage: "es",
      tags: ["youtube", "metadata"],
      localized: {
        title: "No debería persistirse",
        description: "Campo read-only",
      },
    },
    localizations: {
      es: { title: "Título original", description: "Descripción original" },
      en: { title: "Original title EN", description: "Original description EN" },
    },
  };

  return {
    authResolver: {
      resolve: async () => credentials,
      ...overrides?.authResolver,
    },
    youtubeApi: {
      listVideos: async () => [video],
      getVideo: async () => video,
      getVideoMetadataContext: async () => metadataContext,
      applyMetadataProposal: async () => undefined,
      ...overrides?.youtubeApi,
    },
    transcriptProvider: {
      getTranscript: async () => transcript,
      ...overrides?.transcriptProvider,
    },
    metadataGenerator: {
      generate: async () => draft,
      ...overrides?.metadataGenerator,
    },
    logger: {
      info: () => undefined,
      error: () => undefined,
      ...overrides?.logger,
    },
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        shouldPersistSelection: true,
        userId: "user-1",
      }),
      ...overrides?.writeContext,
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => undefined,
      ...overrides?.channelSelectionStore,
    },
  };
}

test("listVideos returns typed list when credentials are valid", async () => {
  const services = createVideoMetadataServices(makeDeps());

  const result = await services.listVideos({
    credentialRef: { userId: "user-1" },
    maxResults: 5,
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0]?.videoId, "video-1");
});

test("listVideos maps unknown adapter errors to unauthorized", async () => {
  const services = createVideoMetadataServices(
    makeDeps({
      youtubeApi: {
        listVideos: async () => {
          throw new Error("forbidden");
        },
      },
    })
  );

  await assert.rejects(
    () => services.listVideos({ credentialRef: { userId: "user-1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
});

test("getTranscript keeps available status", async () => {
  const services = createVideoMetadataServices(makeDeps());

  const result = await services.getTranscript({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
  });

  assert.equal(result.transcript.status, "available");
});

test("getTranscript keeps unavailable status", async () => {
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({ status: "unavailable", reason: "no-captions" }),
      },
    })
  );

  const result = await services.getTranscript({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
  });

  assert.deepEqual(result.transcript, { status: "unavailable", reason: "no-captions" });
});

test("getTranscript preserves granular unavailable reason and diagnostic", async () => {
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({
          status: "unavailable",
          reason: "rate-limited",
          diagnostic: {
            stage: "captions-list",
            httpStatus: 429,
            apiReason: "ratelimitexceeded",
            retriable: true,
          },
        }),
      },
    })
  );

  const result = await services.getTranscript({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
  });

  assert.deepEqual(result.transcript, {
    status: "unavailable",
    reason: "rate-limited",
    diagnostic: {
      stage: "captions-list",
      httpStatus: 429,
      apiReason: "ratelimitexceeded",
      retriable: true,
    },
  });
});

test("getTranscript keeps unsupported status", async () => {
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({ status: "unsupported", reason: "provider-missing" }),
      },
    })
  );

  const result = await services.getTranscript({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
  });

  assert.deepEqual(result.transcript, { status: "unsupported", reason: "provider-missing" });
});

test("previewMetadata returns one finalTitle and one description", async () => {
  const services = createVideoMetadataServices(makeDeps());

  const result = await services.previewMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    editorialPrompt: "Make it clear",
  });

  assert.equal(result.draft.finalTitle, "Final title");
  assert.equal(result.draft.description, "Final description");
});

test("previewMetadata remains enabled when transcript is unavailable", async () => {
  let receivedTranscriptStatus: string | undefined;
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({ status: "unavailable", reason: "no-captions" }),
      },
      metadataGenerator: {
        generate: async ({ transcript }) => {
          receivedTranscriptStatus = transcript.status;
          return makeDraft();
        },
      },
    })
  );

  const result = await services.previewMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    editorialPrompt: "Keep going",
  });

  assert.equal(receivedTranscriptStatus, "unavailable");
  assert.equal(result.transcript.status, "unavailable");
  assert.equal(result.draft.finalTitle, "Final title");
});

test("previewMetadata keeps working with granular transcript diagnostics", async () => {
  let receivedTranscript: TranscriptResult | undefined;
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({
          status: "unavailable",
          reason: "captions-not-downloadable",
          diagnostic: {
            stage: "captions-download",
            httpStatus: 403,
            apiReason: "forbidden",
            retriable: false,
          },
        }),
      },
      metadataGenerator: {
        generate: async ({ transcript }) => {
          receivedTranscript = transcript;
          return makeDraft();
        },
      },
    })
  );

  const result = await services.previewMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    editorialPrompt: "Keep going",
  });

  assert.deepEqual(receivedTranscript, {
    status: "unavailable",
    reason: "captions-not-downloadable",
    diagnostic: {
      stage: "captions-download",
      httpStatus: 403,
      apiReason: "forbidden",
      retriable: false,
    },
  });
  assert.equal(result.transcript.status, "unavailable");
  assert.equal(result.draft.finalTitle, "Final title");
});

test("previewMetadata remains enabled when transcript provider is unsupported", async () => {
  let receivedTranscriptStatus: string | undefined;
  const services = createVideoMetadataServices(
    makeDeps({
      transcriptProvider: {
        getTranscript: async () => ({ status: "unsupported", reason: "provider-missing" }),
      },
      metadataGenerator: {
        generate: async ({ transcript }) => {
          receivedTranscriptStatus = transcript.status;
          return makeDraft();
        },
      },
    })
  );

  const result = await services.previewMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    editorialPrompt: "Keep going",
  });

  assert.equal(receivedTranscriptStatus, "unsupported");
  assert.equal(result.transcript.status, "unsupported");
  assert.equal(result.draft.description, "Final description");
});

test("applyMetadata dryRun and apply share the exact same proposed payload", async () => {
  let applyCalls = 0;
  const services = createVideoMetadataServices(
    makeDeps({
      youtubeApi: {
        applyMetadataProposal: async () => {
          applyCalls += 1;
        },
      },
    })
  );

  const input = {
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    finalTitle: "New title",
    description: "New description",
    expectedChannelId: "UC_ACTIVE",
  };

  // RISK-12 (2026-09-18): dryRun now defaults to true, so the live case must request
  // dryRun: false explicitly -- this test's own intent (compare dry-run vs. live
  // payloads) is unchanged; only the means of requesting the live path changed, per the
  // project owner's approved safety-first default flip (see applyMetadataInputSchema).
  const dryRunResult = await services.applyMetadata({ ...input, dryRun: true });
  const applyResult = await services.applyMetadata({ ...input, dryRun: false });

  assert.equal(dryRunResult.dryRun, true);
  assert.equal(applyResult.dryRun, false);
  assert.equal(applyCalls, 1);
  assert.deepEqual(dryRunResult.snippet.proposed, applyResult.snippet.proposed);
  assert.deepEqual(dryRunResult.localizations.proposed, applyResult.localizations.proposed);
  assert.equal(dryRunResult.targetLanguage, "es");
});

test("RISK-12 (2026-09-18, project-owner-approved safety-first default): omitting dryRun from applyMetadata is a preview, never a real write", async () => {
  let applyCalls = 0;
  const services = createVideoMetadataServices(
    makeDeps({
      youtubeApi: {
        applyMetadataProposal: async () => {
          applyCalls += 1;
        },
      },
    })
  );

  const inputWithoutDryRun = {
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    finalTitle: "New title",
    description: "New description",
    expectedChannelId: "UC_ACTIVE",
  };

  const result = await services.applyMetadata(inputWithoutDryRun);

  assert.equal(result.dryRun, true, "omitting dryRun must default to a preview, not a live write");
  assert.equal(applyCalls, 0, "omitting dryRun must never call the real YouTube write adapter");
});

test("applyMetadata preserves non-editorial snippet fields and non-target localizations", async () => {
  let capturedProposal: unknown;
  const services = createVideoMetadataServices(
    makeDeps({
      youtubeApi: {
        applyMetadataProposal: async ({ proposal }) => {
          capturedProposal = proposal;
        },
      },
    })
  );

  const result = await services.applyMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    finalTitle: "Updated title",
    description: "Updated description",
    expectedChannelId: "UC_ACTIVE",
    dryRun: false, // RISK-12 (2026-09-18): dryRun now defaults to true; this test's own
    // intent (verify the real write's proposed payload) requires requesting it explicitly.
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.targetLanguage, "es");
  assert.equal(result.languageSource, "defaultLanguage");
  assert.equal(result.snippet.proposed.title, "Updated title");
  assert.equal(result.snippet.proposed.description, "Updated description");
  assert.equal(result.snippet.proposed.categoryId, "22");
  assert.equal(result.snippet.proposed.defaultLanguage, "es");
  assert.equal("localized" in result.snippet.proposed, false);
  assert.deepEqual(result.localizations.proposed.en, {
    title: "Original title EN",
    description: "Original description EN",
  });

  const proposal = capturedProposal as {
    update: {
      localizations: Record<string, { title: string; description: string }>;
      snippet: Record<string, unknown>;
    };
  };

  assert.equal(proposal.update.snippet.categoryId, "22");
  assert.deepEqual(proposal.update.localizations.en, {
    title: "Original title EN",
    description: "Original description EN",
  });
});

test("RISK-11 (legacy single-item path, 2026-09-18): every documented read-only snippet field is stripped from the real videos.update request, not only 'localized'", async () => {
  let capturedProposal: unknown;
  const services = createVideoMetadataServices(
    makeDeps({
      youtubeApi: {
        getVideoMetadataContext: async () => ({
          snippet: {
            title: "Original title",
            description: "Original description",
            categoryId: "22",
            defaultLanguage: "es",
            tags: ["youtube", "metadata"],
            defaultAudioLanguage: "es",
            // The other five documented read-only snippet sub-properties
            // (developers.google.com/youtube/v3/docs/videos), exactly as a real
            // videos.list(part=snippet) response would legitimately include them.
            publishedAt: "2026-01-01T00:00:00.000Z",
            channelId: "UC_TEST",
            channelTitle: "Tropico Jazz",
            thumbnails: { default: { url: "https://example.com/v1.jpg" } },
            liveBroadcastContent: "none",
            localized: { title: "No debería persistirse", description: "Campo read-only" },
          },
          localizations: { es: { title: "Título original", description: "Descripción original" } },
        }),
        applyMetadataProposal: async ({ proposal }) => {
          capturedProposal = proposal;
        },
      },
    })
  );

  const result = await services.applyMetadata({
    credentialRef: { userId: "user-1" },
    videoId: "video-1",
    finalTitle: "Updated title",
    description: "Updated description",
    expectedChannelId: "UC_ACTIVE",
    dryRun: false, // RISK-12 (2026-09-18): must request the real write explicitly now.
  });

  for (const readOnlyField of ["publishedAt", "channelId", "channelTitle", "thumbnails", "liveBroadcastContent", "localized"]) {
    assert.equal(readOnlyField in result.snippet.proposed, false, `"${readOnlyField}" must never appear in the response's proposed snippet`);
  }

  const proposal = capturedProposal as { update: { snippet: Record<string, unknown> } };
  for (const readOnlyField of ["publishedAt", "channelId", "channelTitle", "thumbnails", "liveBroadcastContent", "localized"]) {
    assert.equal(readOnlyField in proposal.update.snippet, false, `"${readOnlyField}" must never reach the real videos.update request body`);
  }
  // Writable fields still survive -- this is a whitelist, not a wholesale strip.
  assert.equal(proposal.update.snippet.title, "Updated title");
  assert.equal(proposal.update.snippet.categoryId, "22");
  assert.deepEqual(proposal.update.snippet.tags, ["youtube", "metadata"]);
  assert.equal(proposal.update.snippet.defaultAudioLanguage, "es");
});

test("applyMetadata resolves target language from defaultLanguage or single localization fallback", async () => {
  const testCases = [
    {
      name: "defaultLanguage",
      context: {
        snippet: {
          title: "t",
          description: "d",
          categoryId: "22",
          defaultLanguage: "es",
        },
        localizations: {
          es: { title: "t", description: "d" },
          en: { title: "t-en", description: "d-en" },
        },
      },
      expectedLanguage: "es",
      expectedSource: "defaultLanguage",
    },
    {
      name: "single-localization-fallback",
      context: {
        snippet: {
          title: "t",
          description: "d",
          categoryId: "22",
        },
        localizations: {
          pt: { title: "t-pt", description: "d-pt" },
        },
      },
      expectedLanguage: "pt",
      expectedSource: "existing-localization",
    },
  ] as const;

  for (const testCase of testCases) {
    const services = createVideoMetadataServices(
      makeDeps({
        youtubeApi: {
          getVideoMetadataContext: async () => testCase.context,
        },
      })
    );

    const result = await services.applyMetadata({
      credentialRef: { userId: "user-1" },
      videoId: "video-1",
      finalTitle: "Nuevo",
      description: "Descripción",
      expectedChannelId: "UC_ACTIVE",
      dryRun: true,
    });

    assert.equal(result.targetLanguage, testCase.expectedLanguage, testCase.name);
    assert.equal(result.languageSource, testCase.expectedSource, testCase.name);
  }
});

test("applyMetadata blocks when target language is not uniquely resolvable", async () => {
  const blockingCases = [
    {
      name: "missing-default-and-no-localizations",
      context: {
        snippet: { title: "t", description: "d", categoryId: "22" },
        localizations: {},
      },
    },
    {
      name: "missing-default-and-ambiguous-localizations",
      context: {
        snippet: { title: "t", description: "d", categoryId: "22" },
        localizations: {
          es: { title: "t-es", description: "d-es" },
          en: { title: "t-en", description: "d-en" },
        },
      },
    },
  ] as const;

  for (const blockingCase of blockingCases) {
    let applyCalls = 0;
    const services = createVideoMetadataServices(
      makeDeps({
        youtubeApi: {
          getVideoMetadataContext: async () => blockingCase.context,
          applyMetadataProposal: async () => {
            applyCalls += 1;
          },
        },
      })
    );

    await assert.rejects(
      () =>
        services.applyMetadata({
          credentialRef: { userId: "user-1" },
          videoId: "video-1",
          finalTitle: "Nuevo",
          description: "Descripción",
          expectedChannelId: "UC_ACTIVE",
          dryRun: true,
        }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "target_language_unresolvable" &&
        /Cannot resolve target language/.test(error.message),
      blockingCase.name
    );

    assert.equal(applyCalls, 0, `${blockingCase.name} should not mutate`);
  }
});

test("applyMetadata fails closed when write-channel guardrail rejects", async () => {
  let applyCalls = 0;
  const services = createVideoMetadataServices(
    makeDeps({
      writeContext: {
        assertWriteChannel: async () => {
          throw new DomainError({
            code: "WRITE_CHANNEL_MISMATCH",
            message: "expectedChannelId does not match the active write channel",
            details: {
              expectedChannelId: "UC_EXPECTED",
              activeWriteChannelId: "UC_ACTIVE",
            },
          });
        },
      },
      youtubeApi: {
        applyMetadataProposal: async () => {
          applyCalls += 1;
        },
      },
    })
  );

  await assert.rejects(
    () =>
      services.applyMetadata({
        credentialRef: { userId: "user-1" },
        videoId: "video-1",
        finalTitle: "Nuevo",
        description: "Descripción",
        expectedChannelId: "UC_EXPECTED",
        dryRun: false,
      }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );

  assert.equal(applyCalls, 0);
});
