import {
  YOUTUBE_DESCRIPTION_MAX_LENGTH,
  YOUTUBE_TITLE_MAX_LENGTH,
  classifyFieldChange,
  isValidLanguageCode,
} from "@/lib/changesets/diff";
import type { ChangeSet } from "@/lib/changesets/contracts";
import {
  DomainError,
  isDomainError,
  type EditorialProfile,
  type GeneratedFieldOutcome,
  type GeneratedTargetResult,
  type GenerationContext,
  type GenerationProvenance,
  type GenerationResult,
  type GenerationRowError,
  type GenerationSummary,
  type LocalizationGenerationOutcome,
  type LocalizationProvider,
  type ReviewedProposal,
  type StoredChannelRecord,
  type StoredVideoRecord,
} from "./contracts";
import {
  createChangeSetFromGenerationInputSchema,
  generateProposalsInputSchema,
  getEditorialProfileInputSchema,
  getGenerationProvenanceInputSchema,
  saveEditorialProfileInputSchema,
  parseWithSchema,
} from "./schemas";

type StoredEditorialProfileRecord = {
  channelId: string;
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: Date;
};

function toEditorialProfileRecord(stored: StoredEditorialProfileRecord): EditorialProfile {
  return {
    channelId: stored.channelId,
    version: stored.version,
    targetAudience: stored.targetAudience,
    toneNotes: stored.toneNotes,
    terminologyNotes: stored.terminologyNotes,
    titleConstraints: stored.titleConstraints,
    descriptionConstraints: stored.descriptionConstraints,
    updatedAt: stored.updatedAt.toISOString(),
  };
}

/**
 * Combines a channel's persistent editorial profile with an optional per-request
 * override, per field (docs/acceptance/PHASE_6_ACCEPTANCE.md AC-PROFILE-05/06): for
 * each of the five fields, an explicitly-supplied per-request value wins; otherwise
 * the profile's value (if any) is used; if neither supplies a value, the field is
 * simply absent from the result. Returns `null` only when every field would be
 * absent (nothing to send at all). This is a pure combination of already-validated,
 * already-bounded-length text -- it never invents, defaults, or looks up any
 * channel-specific content itself (`AGENTS.md` §B).
 */
function mergeEditorialContext(
  profile: StoredEditorialProfileRecord | null,
  requestBrief: GenerationContext | undefined
): GenerationContext | null {
  const fields: Array<keyof GenerationContext> = [
    "targetAudience",
    "toneNotes",
    "terminologyNotes",
    "titleConstraints",
    "descriptionConstraints",
  ];

  const merged: GenerationContext = {};
  for (const field of fields) {
    const override = requestBrief?.[field];
    const fallback = profile?.[field] ?? undefined;
    const value = override !== undefined ? override : fallback;
    if (value !== undefined && value !== null) {
      merged[field] = value;
    }
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

const REAL_CONNECTION_MAX_TARGETS_PER_CALL = 50;

type ChangeToPersist = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: "add" | "modify" | "unchanged";
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
};

type ServiceDependencies = {
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
  };
  resolveProvider(providerName: string): LocalizationProvider;
  defaultProviderName: string;
  /** Phase 6, AI Connections: resolves a user-configured connection into a
   * `LocalizationProvider`. Optional so every existing test fixture that never
   * exercises `connectionId` keeps working unchanged (AGENTS.md §D: this domain's
   * own logic is not required to know connections exist unless a caller opts in). */
  resolveConnectionProvider?(connectionId: string): Promise<LocalizationProvider>;
  changeSetServices: {
    createChangeSetFromProposals(input: {
      channelId: string;
      source: ChangeSet["source"];
      changes: ChangeToPersist[];
    }): Promise<ChangeSet>;
  };
  profileStore: {
    getProfile(channelId: string): Promise<StoredEditorialProfileRecord | null>;
    saveProfile(input: {
      channelId: string;
      targetAudience?: string | null;
      toneNotes?: string | null;
      terminologyNotes?: string | null;
      titleConstraints?: string | null;
      descriptionConstraints?: string | null;
    }): Promise<StoredEditorialProfileRecord>;
  };
  provenanceStore: {
    create(input: {
      id: string;
      changeSetId: string;
      channelId: string;
      profileVersion: number | null;
      effectiveContextJson: string | null;
    }): Promise<void>;
    getByChangeSetId(changeSetId: string): Promise<{
      id: string;
      changeSetId: string;
      channelId: string;
      profileVersion: number | null;
      effectiveContextJson: string | null;
      createdAt: Date;
    } | null>;
  };
  idGenerator: () => string;
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
};

function mapUnknownError(error: unknown, fallbackCode: DomainError["code"]) {
  if (isDomainError(error)) return error;
  return new DomainError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

async function requireChannel(deps: ServiceDependencies, channelId: string): Promise<StoredChannelRecord> {
  const channel = await deps.channelStore.getChannel(channelId);
  if (!channel) {
    throw new DomainError({
      code: "not_found",
      message: "Channel has not been synchronized yet",
      details: { channelId },
    });
  }
  return channel;
}

/**
 * Classifies and validates one proposed field value against the video's current
 * synchronized remote value -- the exact same field-level rules XLSX import applies
 * (src/lib/changesets/diff.ts / import.ts), so an AI-generated proposal is held to no
 * lower a bar than a human-edited spreadsheet row. `proposedValue` is the value after
 * any human edit made during the "inspect and edit" step of the workflow.
 */
function classifyAndValidateField(
  currentRemoteValue: string,
  proposedValue: string,
  field: "title" | "description"
): Pick<GeneratedFieldOutcome, "changeType" | "validationStatus" | "validationError"> {
  const trimmed = proposedValue.trim();
  const maxLength = field === "title" ? YOUTUBE_TITLE_MAX_LENGTH : YOUTUBE_DESCRIPTION_MAX_LENGTH;

  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = `AI-generated ${field} is empty after generation/editing`;
  } else if (proposedValue.length > maxLength) {
    validationError = `${field} exceeds ${maxLength} characters (${proposedValue.length})`;
  }

  return {
    changeType: classifyFieldChange(currentRemoteValue, proposedValue),
    validationStatus: validationError ? "invalid" : "valid",
    validationError,
  };
}

function currentRemoteValueFor(video: StoredVideoRecord, language: string, field: "title" | "description"): string {
  const locale = video.existingLocalizations[language];
  return locale ? locale[field] : "";
}

export function createAiLocalizationServices(deps: ServiceDependencies) {
  return {
    /**
     * Step 1-2 of the workflow ("generate localization proposals" -> "validate
     * output"). Calls the resolved `LocalizationProvider` for every distinct
     * (videoId, targetLanguage) pair and returns fully classified, human-reviewable
     * proposals. Persists nothing -- mirrors `changesets.previewImport`'s "preview
     * only" contract.
     */
    async generateProposals(input: unknown): Promise<GenerationResult> {
      const parsedInput = parseWithSchema(generateProposalsInputSchema, input, "generate proposals input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const videos = await deps.channelStore.listVideosByChannel(channel.channelId);
        const videoMap = new Map(videos.map((v) => [v.videoId, v]));

        let provider: LocalizationProvider;
        if (parsedInput.connectionId) {
          if (!deps.resolveConnectionProvider) {
            throw new DomainError({ code: "provider_not_configured", message: "AI Connections are not wired into this service instance" });
          }
          provider = await deps.resolveConnectionProvider(parsedInput.connectionId);
        } else {
          provider = deps.resolveProvider(parsedInput.providerName ?? deps.defaultProviderName);
        }

        const profile = await deps.profileStore.getProfile(channel.channelId);
        const effectiveContext = mergeEditorialContext(profile, parsedInput.editorialBrief);
        const generationContext: GenerationProvenance = {
          profileVersion: profile?.version ?? null,
          effectiveContext,
        };

        const errors: GenerationRowError[] = [];
        const seenTargets = new Set<string>();
        const targets: Array<{ videoId: string; language: string; video: StoredVideoRecord }> = [];

        for (const videoId of parsedInput.videoIds) {
          const video = videoMap.get(videoId);
          for (const language of parsedInput.targetLanguages) {
            if (!isValidLanguageCode(language)) {
              errors.push({ videoId, language, message: `Invalid target language code format: "${language}"` });
              continue;
            }
            if (!video) {
              errors.push({
                videoId,
                language,
                message: "video_id does not belong to this channel's synchronized data (wrong channel, or not synced)",
              });
              continue;
            }

            const key = `${videoId}::${language}`;
            if (seenTargets.has(key)) {
              errors.push({ videoId, language, message: "Duplicate (videoId, language) generation target" });
              continue;
            }
            seenTargets.add(key);
            targets.push({ videoId, language, video });
          }
        }

        // Cost control (docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md §7): the
        // mock provider's target cap (via videoIds/targetLanguages array limits in
        // schemas.ts) is far too high to safely apply to a REAL, potentially-paid
        // connection. A connection-backed call is capped much lower, independent of
        // and in addition to those schema-level limits.
        if (parsedInput.connectionId && targets.length > REAL_CONNECTION_MAX_TARGETS_PER_CALL) {
          throw new DomainError({
            code: "validation_failed",
            message: `A single generation call through a real connection is limited to ${REAL_CONNECTION_MAX_TARGETS_PER_CALL} (video, language) targets; this call would have made ${targets.length}. Split it into smaller batches.`,
            details: { requested: targets.length, limit: REAL_CONNECTION_MAX_TARGETS_PER_CALL },
          });
        }

        const results: GeneratedTargetResult[] = [];
        for (const target of targets) {
          // A provider is untrusted, out-of-process (in spirit) code: it can throw
          // synchronously or reject its promise instead of resolving to a
          // { status: "error" } outcome (network timeout, thrown exception, bug).
          // INV-6.2 requires isolation from *any* provider failure, not only the
          // outcome shape the provider is supposed to use -- so this is caught here,
          // per target, rather than letting it propagate to the outer try/catch and
          // abort/lose every other target already generated in this same request.
          let outcome: LocalizationGenerationOutcome;
          try {
            outcome = await provider.generate({
              videoId: target.videoId,
              targetLanguage: target.language,
              sourceLanguage: target.video.defaultLanguage,
              sourceTitle: target.video.title,
              sourceDescription: target.video.description,
              ...(effectiveContext ? { editorialBrief: effectiveContext } : {}),
            });
          } catch (providerError) {
            results.push({
              videoId: target.videoId,
              language: target.language,
              providerError: providerError instanceof Error ? providerError.message : "Unknown provider error",
              fields: [],
              usage: null,
            });
            continue;
          }

          if (outcome.status === "error") {
            results.push({ videoId: target.videoId, language: target.language, providerError: outcome.message, fields: [], usage: null });
            continue;
          }

          const fields: GeneratedFieldOutcome[] = (
            [
              { field: "title" as const, proposedValue: outcome.title },
              { field: "description" as const, proposedValue: outcome.description },
            ]
          ).map(({ field, proposedValue }) => {
            const currentRemoteValue = currentRemoteValueFor(target.video, target.language, field);
            const classified = classifyAndValidateField(currentRemoteValue, proposedValue, field);
            return {
              videoId: target.videoId,
              language: target.language,
              field,
              baselineValue: currentRemoteValue,
              proposedValue,
              ...classified,
            };
          });

          results.push({
            videoId: target.videoId,
            language: target.language,
            providerError: null,
            fields,
            usage: outcome.usage ?? null,
          });
        }

        const allFields = results.flatMap((r) => r.fields);
        const summary: GenerationSummary = {
          targetsRequested: targets.length,
          targetsGenerated: results.filter((r) => r.providerError === null).length,
          targetsFailed: results.filter((r) => r.providerError !== null).length,
          validProposals: allFields.filter((f) => f.validationStatus === "valid" && f.changeType !== "unchanged").length,
          invalidProposals: allFields.filter((f) => f.validationStatus === "invalid").length,
          unchangedProposals: allFields.filter((f) => f.validationStatus === "valid" && f.changeType === "unchanged").length,
        };

        deps.logger.info({
          event: "ai_localization.generate.success",
          context: { channelId: channel.channelId, ...summary },
        });

        return { results, errors, summary, generationContext };
      } catch (error) {
        const mapped = mapUnknownError(error, "generation_failed");
        deps.logger.error({ event: "ai_localization.generate.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /**
     * Step 3-4 of the workflow ("inspect and edit proposals" -> "create Change Set").
     * Takes the human-reviewed (possibly edited) proposals and hands them to the
     * existing, unmodified ChangeSet creation path
     * (`changesets.createChangeSetFromProposals`, `source: "ai_localization"`).
     * Everything downstream -- approval, revalidation/conflict detection, Batch
     * creation, dry-run -- is the exact same Phase 4/5 pipeline XLSX-imported
     * changes already go through (AGENTS.md §D).
     */
    async createChangeSetFromGeneration(input: unknown): Promise<ChangeSet> {
      const parsedInput = parseWithSchema(createChangeSetFromGenerationInputSchema, input, "create change set from generation input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const videos = await deps.channelStore.listVideosByChannel(channel.channelId);
        const videoMap = new Map(videos.map((v) => [v.videoId, v]));

        const seenTargets = new Set<string>();
        const changesToPersist: ChangeToPersist[] = [];

        for (const proposal of parsedInput.proposals as ReviewedProposal[]) {
          if (!isValidLanguageCode(proposal.language)) {
            throw new DomainError({
              code: "generation_invalid_target_language",
              message: `Invalid target language code format: "${proposal.language}"`,
              details: { videoId: proposal.videoId, language: proposal.language },
            });
          }

          const video = videoMap.get(proposal.videoId);
          if (!video) {
            throw new DomainError({
              code: "not_found",
              message: "video_id does not belong to this channel's synchronized data (wrong channel, or not synced)",
              details: { videoId: proposal.videoId },
            });
          }

          const key = `${proposal.videoId}::${proposal.language}`;
          if (seenTargets.has(key)) {
            throw new DomainError({
              code: "validation_failed",
              message: "Duplicate (videoId, language) proposal submitted",
              details: { videoId: proposal.videoId, language: proposal.language },
            });
          }
          seenTargets.add(key);

          const fieldInputs: Array<{ field: "title" | "description"; proposedValue: string | undefined }> = [
            { field: "title", proposedValue: proposal.title },
            { field: "description", proposedValue: proposal.description },
          ];

          for (const { field, proposedValue } of fieldInputs) {
            // Omitted field = no proposed change for it, same "blank = no change"
            // rule as XLSX import (docs/PROJECT_SPEC.md §8) -- never a deletion.
            if (proposedValue === undefined) continue;

            const currentRemoteValue = currentRemoteValueFor(video, proposal.language, field);
            const classified = classifyAndValidateField(currentRemoteValue, proposedValue, field);

            if (classified.changeType === "unchanged" && classified.validationStatus === "valid") continue;

            changesToPersist.push({
              id: deps.idGenerator(),
              videoId: proposal.videoId,
              language: proposal.language,
              field,
              baselineValue: currentRemoteValue,
              proposedValue,
              // AI-generated proposals are always classified fresh against the
              // current local sync mirror at creation time -- there is no
              // export-time baseline that can have drifted yet, so this always
              // starts "none" (never fabricated as "conflict"). Existing
              // revalidation (changesets/diff.ts, run on every subsequent read)
              // still re-checks it against the current remote before approval.
              conflictStatus: "none",
              ...classified,
            });
          }
        }

        if (changesToPersist.length === 0) {
          throw new DomainError({
            code: "generation_no_proposals",
            message: "No actionable proposals were submitted (all were unchanged, or every field was omitted)",
          });
        }

        const changeSet = await deps.changeSetServices.createChangeSetFromProposals({
          channelId: channel.channelId,
          source: "ai_localization",
          changes: changesToPersist,
        });

        // Provenance is optional and purely additive: it is an echo, supplied by the
        // caller, of exactly what a prior `generateProposals` call returned (see
        // GenerationResult.generationContext) -- never re-derived from the LIVE
        // profile here, since the whole point is to survive the profile later being
        // edited or deleted (docs/acceptance/PHASE_6_ACCEPTANCE.md AC-PROFILE-08/09).
        // A client that omits it simply gets no provenance row; nothing else about
        // Change Set creation depends on it.
        if (parsedInput.provenance) {
          await deps.provenanceStore.create({
            id: deps.idGenerator(),
            changeSetId: changeSet.id,
            channelId: channel.channelId,
            profileVersion: parsedInput.provenance.profileVersion,
            effectiveContextJson: parsedInput.provenance.effectiveContext
              ? JSON.stringify(parsedInput.provenance.effectiveContext)
              : null,
          });
        }

        deps.logger.info({
          event: "ai_localization.create_change_set.success",
          context: { channelId: channel.channelId, changeSetId: changeSet.id, changeCount: changesToPersist.length },
        });

        return changeSet;
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "ai_localization.create_change_set.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /** Returns the channel's current editorial profile, or `null` if none has ever
     * been saved -- never a default/invented one (`AGENTS.md` §B). */
    async getEditorialProfile(input: unknown): Promise<EditorialProfile | null> {
      const parsedInput = parseWithSchema(getEditorialProfileInputSchema, input, "get editorial profile input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const stored = await deps.profileStore.getProfile(channel.channelId);
        return stored ? toEditorialProfileRecord(stored) : null;
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    /**
     * Creates or updates a channel's editorial profile. Every field is optional and
     * independently nullable: omitting a field leaves its stored value unchanged;
     * submitting `null` explicitly clears it. Every save bumps `version` (including
     * the first), which is what a later generation's provenance record points back
     * to. Content itself is never validated for meaning -- only bounded in length
     * (schemas.ts) -- this repository does not know or judge what a channel's
     * editorial policy should say (`AGENTS.md` §B).
     */
    async saveEditorialProfile(input: unknown): Promise<EditorialProfile> {
      const parsedInput = parseWithSchema(saveEditorialProfileInputSchema, input, "save editorial profile input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const stored = await deps.profileStore.saveProfile({
          channelId: channel.channelId,
          targetAudience: parsedInput.targetAudience,
          toneNotes: parsedInput.toneNotes,
          terminologyNotes: parsedInput.terminologyNotes,
          titleConstraints: parsedInput.titleConstraints,
          descriptionConstraints: parsedInput.descriptionConstraints,
        });

        deps.logger.info({
          event: "ai_localization.profile.save.success",
          context: { channelId: channel.channelId, version: stored.version },
        });

        return toEditorialProfileRecord(stored);
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "ai_localization.profile.save.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /**
     * Returns the immutable provenance record for a Change Set, if one was recorded
     * at creation time -- `null` if the Change Set was created without echoing
     * `generationContext` back (e.g. an XLSX-imported Change Set, or an
     * ai_localization one from before this feature existed). Channel-scoped: a
     * provenance row belonging to a different channel than requested is treated as
     * not found, exactly like every other channel-scoped resource in this codebase
     * (`AGENTS.md` §F).
     */
    async getGenerationProvenance(input: unknown): Promise<GenerationProvenance | null> {
      const parsedInput = parseWithSchema(getGenerationProvenanceInputSchema, input, "get generation provenance input");

      try {
        await requireChannel(deps, parsedInput.channelId);
        const stored = await deps.provenanceStore.getByChangeSetId(parsedInput.changeSetId);
        if (!stored || stored.channelId !== parsedInput.channelId) return null;

        return {
          profileVersion: stored.profileVersion,
          effectiveContext: stored.effectiveContextJson ? (JSON.parse(stored.effectiveContextJson) as GenerationContext) : null,
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },
  };
}

export type AiLocalizationServices = ReturnType<typeof createAiLocalizationServices>;
