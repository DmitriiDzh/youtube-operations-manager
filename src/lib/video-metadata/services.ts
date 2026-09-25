import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { pickWritableSnippetFields } from "@/lib/youtube-write-gateway";
import {
  DomainError,
  mapUnknownError,
  type MetadataLanguageSource,
  type MetadataApplyResult,
  type MetadataDraft,
  type MetadataSyncProposal,
  type ResolvedCredentials,
  type TranscriptResult,
  type VideoMetadataContext,
  type VideoMetadataItem,
} from "./contracts";
import {
  applyMetadataInputSchema,
  applyMetadataOutputSchema,
  listVideosInputSchema,
  listVideosOutputSchema,
  metadataDraftSchema,
  parseWithSchema,
  previewMetadataInputSchema,
  previewMetadataOutputSchema,
  transcriptInputSchema,
  transcriptOutputSchema,
} from "./schemas";

type ServiceDependencies = {
  authResolver: {
    resolve(args: {
      credentialRef: unknown;
      requiredScopes: readonly string[];
    }): Promise<ResolvedCredentials>;
  };
  youtubeApi: {
    listVideos(args: {
      credentials: ResolvedCredentials;
      channelId?: string;
      maxResults?: number;
    }): Promise<VideoMetadataItem[]>;
    getVideo(args: {
      credentials: ResolvedCredentials;
      videoId: string;
    }): Promise<VideoMetadataItem>;
    getVideoMetadataContext(args: {
      credentials: ResolvedCredentials;
      videoId: string;
    }): Promise<VideoMetadataContext>;
    applyMetadataProposal(args: {
      credentials: ResolvedCredentials;
      proposal: MetadataSyncProposal;
    }): Promise<void>;
  };
  transcriptProvider: {
    getTranscript(args: {
      credentials: ResolvedCredentials;
      videoId: string;
    }): Promise<TranscriptResult>;
  };
  metadataGenerator: {
    generate(args: {
      video: VideoMetadataItem;
      transcript: TranscriptResult;
      editorialPrompt: string;
    }): Promise<MetadataDraft>;
  };
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
  writeContext: {
    assertWriteChannel(args: {
      credentialRef: unknown;
      credentials: ResolvedCredentials;
      expectedChannelId?: string;
    }): Promise<{
      expectedChannelId: string;
      shouldPersistSelection: boolean;
      userId: string | null;
    }>;
  };
  channelSelectionStore: {
    setSelectedChannelId(userId: string, channelId: string): Promise<void>;
  };
};

export type { ServiceDependencies };

/**
 * RISK-11 (extended to this legacy single-item write path, 2026-09-18): previously
 * stripped only `.localized`, leaving five other documented read-only `snippet`
 * sub-properties (`publishedAt`, `channelId`, `channelTitle`, `thumbnails`,
 * `liveBroadcastContent`) echoed back unchanged on every real `videos.update` call this
 * function's callers make. Now delegates to the shared, canonical whitelist
 * (`src/lib/youtube-write-gateway/index.ts`'s `pickWritableSnippetFields`) instead of keeping
 * its own, narrower copy -- the exact same fix already applied to `src/lib/batches/merge.ts`.
 */
function removeReadOnlySnippetFields(snippet: Record<string, unknown>) {
  return pickWritableSnippetFields(snippet);
}

function resolveTargetLanguage(context: VideoMetadataContext): {
  targetLanguage: string;
  languageSource: MetadataLanguageSource;
} {
  const defaultLanguage =
    typeof context.snippet.defaultLanguage === "string" &&
    context.snippet.defaultLanguage.trim().length > 0
      ? context.snippet.defaultLanguage.trim()
      : null;

  if (defaultLanguage) {
    return {
      targetLanguage: defaultLanguage,
      languageSource: "defaultLanguage",
    };
  }

  const localizationLocales = Object.keys(context.localizations);
  if (localizationLocales.length === 1) {
    const [inferredLanguage] = localizationLocales;
    if (!inferredLanguage) {
      throw new DomainError({
        code: "target_language_unresolvable",
        message: "Cannot resolve target language from YouTube metadata",
      });
    }

    return {
      targetLanguage: inferredLanguage,
      languageSource: "existing-localization",
    };
  }

  throw new DomainError({
    code: "target_language_unresolvable",
    message:
      "Cannot resolve target language. Set snippet.defaultLanguage on the video or leave exactly one localization.",
    details: {
      videoDefaultLanguage: context.snippet.defaultLanguage ?? null,
      localizationLocales,
    },
  });
}

function buildMetadataSyncProposal(args: {
  videoId: string;
  context: VideoMetadataContext;
  draft: MetadataDraft;
}): MetadataSyncProposal {
  const resolvedLanguage = resolveTargetLanguage(args.context);
  const beforeSnippet = removeReadOnlySnippetFields(args.context.snippet);
  const proposedSnippet = removeReadOnlySnippetFields({
    ...beforeSnippet,
    title: args.draft.finalTitle,
    description: args.draft.description,
    defaultLanguage: resolvedLanguage.targetLanguage,
  });

  const beforeLocalizations = { ...args.context.localizations };
  const proposedLocalizations = {
    ...beforeLocalizations,
    [resolvedLanguage.targetLanguage]: {
      ...beforeLocalizations[resolvedLanguage.targetLanguage],
      title: args.draft.finalTitle,
      description: args.draft.description,
    },
  };

  return {
    targetLanguage: resolvedLanguage.targetLanguage,
    languageSource: resolvedLanguage.languageSource,
    snippet: {
      before: beforeSnippet,
      proposed: proposedSnippet,
    },
    localizations: {
      before: beforeLocalizations,
      proposed: proposedLocalizations,
      affected: [
        {
          locale: resolvedLanguage.targetLanguage,
          before: beforeLocalizations[resolvedLanguage.targetLanguage] ?? null,
          proposed: proposedLocalizations[resolvedLanguage.targetLanguage],
          source: resolvedLanguage.languageSource,
        },
      ],
    },
    update: {
      videoId: args.videoId,
      snippet: proposedSnippet,
      localizations: proposedLocalizations,
    },
  };
}

export function createVideoMetadataServices(deps: ServiceDependencies) {
  return {
    async listVideos(input: unknown) {
      const parsedInput = parseWithSchema(listVideosInputSchema, input, "list videos input");

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });

        const videos = await deps.youtubeApi.listVideos({
          credentials,
          channelId: parsedInput.channelId,
          maxResults: parsedInput.maxResults,
        });

        const output = parseWithSchema(
          listVideosOutputSchema,
          { videos },
          "list videos output"
        );

        deps.logger.info({
          event: "video_metadata.list.success",
          context: { count: output.videos.length, channelId: parsedInput.channelId ?? "default" },
        });

        return output;
      } catch (error) {
        const mapped = mapUnknownError(error, "unauthorized");
        deps.logger.error({ event: "video_metadata.list.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async getTranscript(input: unknown) {
      const parsedInput = parseWithSchema(transcriptInputSchema, input, "transcript input");

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });

        const transcript = await deps.transcriptProvider.getTranscript({
          credentials,
          videoId: parsedInput.videoId,
        });

        const output = parseWithSchema(
          transcriptOutputSchema,
          { transcript },
          "transcript output"
        );

        return output;
      } catch (error) {
        throw mapUnknownError(error, "transcript_unavailable");
      }
    },

    async previewMetadata(input: unknown) {
      const parsedInput = parseWithSchema(
        previewMetadataInputSchema,
        input,
        "preview metadata input"
      );

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });

        const video = await deps.youtubeApi.getVideo({
          credentials,
          videoId: parsedInput.videoId,
        });

        const transcriptResult = await deps.transcriptProvider.getTranscript({
          credentials,
          videoId: parsedInput.videoId,
        });

        const draft = await deps.metadataGenerator.generate({
          video,
          transcript: transcriptResult,
          editorialPrompt: parsedInput.editorialPrompt,
        });

        const output = parseWithSchema(
          previewMetadataOutputSchema,
          {
            video,
            transcript: transcriptResult,
            draft,
          },
          "preview metadata output"
        );

        deps.logger.info({
          event: "video_metadata.preview.success",
          context: { videoId: parsedInput.videoId, transcriptStatus: output.transcript.status },
        });

        return output;
      } catch (error) {
        throw mapUnknownError(error, "generation_failed");
      }
    },

    async applyMetadata(input: unknown): Promise<MetadataApplyResult> {
      const parsedInput = parseWithSchema(
        applyMetadataInputSchema,
        input,
        "apply metadata input"
      );

      const draft = parseWithSchema(
        metadataDraftSchema,
        {
          finalTitle: parsedInput.finalTitle,
          description: parsedInput.description,
          promptVersion: "manual-input",
        },
        "metadata draft"
      );

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_WRITE_SCOPE],
        });

        const guardrail = await deps.writeContext.assertWriteChannel({
          credentialRef: parsedInput.credentialRef,
          credentials,
          expectedChannelId: parsedInput.expectedChannelId,
        });

        const metadataContext = await deps.youtubeApi.getVideoMetadataContext({
          credentials,
          videoId: parsedInput.videoId,
        });

        const proposal = buildMetadataSyncProposal({
          videoId: parsedInput.videoId,
          context: metadataContext,
          draft,
        });

        if (parsedInput.dryRun) {
          return parseWithSchema(
            applyMetadataOutputSchema,
            {
              dryRun: true,
              videoId: parsedInput.videoId,
              targetLanguage: proposal.targetLanguage,
              languageSource: proposal.languageSource,
              snippet: proposal.snippet,
              localizations: proposal.localizations,
            },
            "apply metadata output"
          );
        }

        await deps.youtubeApi.applyMetadataProposal({
          credentials,
          proposal,
        });

        if (guardrail.shouldPersistSelection && guardrail.userId) {
          await deps.channelSelectionStore.setSelectedChannelId(
            guardrail.userId,
            guardrail.expectedChannelId
          );
        }

        const output = parseWithSchema(
          applyMetadataOutputSchema,
          {
            dryRun: false,
            videoId: parsedInput.videoId,
            targetLanguage: proposal.targetLanguage,
            languageSource: proposal.languageSource,
            snippet: proposal.snippet,
            localizations: proposal.localizations,
          },
          "apply metadata output"
        );

        deps.logger.info({
          event: "video_metadata.apply.success",
          context: {
            videoId: parsedInput.videoId,
            dryRun: false,
            targetLanguage: proposal.targetLanguage,
          },
        });

        return output;
      } catch (error) {
        throw mapUnknownError(error, "update_failed");
      }
    },
  };
}
