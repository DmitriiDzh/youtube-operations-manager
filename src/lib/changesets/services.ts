import {
  DomainError,
  mapUnknownError,
  type Change,
  type ChangeSet,
  type ChangeType,
  type ImportRowError,
  type ImportSummary,
  type StoredChangeRecord,
  type StoredChangeSetRecord,
  type StoredChannelRecord,
  type StoredVideoRecord,
} from "./contracts";
import { computeChangeSetStatus, currentRemoteValueFor, revalidateChangeAgainstCurrentRemote } from "./diff";
import { classifyRowForSummary, parseAndValidateWorkbook, summarizeParsedWorkbook } from "./import";
import {
  changeActionInputSchema,
  changeSetBulkActionInputSchema,
  getChangeSetInputSchema,
  importWorkbookInputSchema,
  listChangeSetsInputSchema,
  parseWithSchema,
  proposeLocalizationDeletionInputSchema,
} from "./schemas";

const MAX_PREVIEW_ERRORS_RETURNED = 200;
const DEFAULT_PAGE_SIZE = 50;

type ChangeSetStoreDeps = {
  createChangeSetWithChanges(input: {
    id: string;
    channelId: string;
    source: ChangeSet["source"];
    status: ChangeSet["status"];
    importedFilename: string | null;
    schemaVersion: string | null;
    exportedAt: string | null;
    changes: Array<{
      id: string;
      videoId: string;
      language: string;
      field: "title" | "description";
      baselineValue: string;
      proposedValue: string;
      changeType: ChangeType;
      validationStatus: "valid" | "invalid";
      validationError: string | null;
      conflictStatus: "none" | "conflict";
    }>;
  }): Promise<void>;
  listChangeSetsByChannel(channelId: string): Promise<StoredChangeSetRecord[]>;
  getChangeSet(changeSetId: string): Promise<StoredChangeSetRecord | null>;
  listChangesByChangeSet(changeSetId: string): Promise<StoredChangeRecord[]>;
  updateChangeSetStatus(changeSetId: string, status: ChangeSet["status"]): Promise<void>;
  updateChange(
    changeId: string,
    patch: Partial<Pick<StoredChangeRecord, "conflictStatus" | "approvalStatus" | "approvedValue">>
  ): Promise<void>;
  bulkUpdateChanges(
    updates: Array<{
      id: string;
      patch: Partial<Pick<StoredChangeRecord, "conflictStatus" | "approvalStatus" | "approvedValue">>;
    }>
  ): Promise<void>;
};

type ServiceDependencies = {
  channelStore: {
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
  };
  changeSetStore: ChangeSetStoreDeps;
  /**
   * The CRDT-level `FieldConflict` concept (`src/lib/change-drafts/`, two devices concurrently
   * edited the same field, AUTOMERGE_MIGRATION_PLAN.md §6 CD6) is distinct from this module's own
   * `conflictStatus` (baseline vs. currently-synced-remote-value). `docs/TECHNICAL_DEBT.md`
   * RISK-47: without this, an operator could approve a change whose value is Automerge's
   * arbitrary deterministic pick while a real, unresolved conflict on that exact field sits in
   * the Merge tab. `listConflictedChangeIds` returns every `changeId` this channel currently has
   * at least one open field conflict for; `approveChange`/`approveAllValid` refuse to approve any
   * change in that set, exactly like they already refuse one with `conflictStatus: "conflict"`.
   * `rejectChange`/`rejectAllPending` deliberately do NOT call this -- rejecting a contested
   * change discards it either way, so there is nothing a CRDT conflict could make incorrect (see
   * the existing "rejecting is always allowed, including for invalid/conflicting changes" test).
   *
   * Deliberately an approval-time gate only, not a read-path check: this does a full document
   * scan (`Automerge.load` + `scanForConflicts`, `change-drafts/services.ts`'s `listConflicts`)
   * every call. Fine on `approveChange`'s single-change path; do NOT wire this into `getChangeSet`
   * or `listChangeSets` for read-time badging -- that would turn one document scan into one per
   * change set on every page load. If a future need arises to show conflict status on reads, use
   * `change-drafts`'s own `listConflicts`/SQL projection directly instead of this dependency.
   */
  crdtConflicts: {
    listConflictedChangeIds(channelId: string): Promise<Set<string>>;
  };
  idGenerator: () => string;
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
};

function toIso(date: Date): string {
  return date.toISOString();
}

function toChangeRecord(stored: StoredChangeRecord): Change {
  return {
    id: stored.id,
    changeSetId: stored.changeSetId,
    videoId: stored.videoId,
    language: stored.language,
    field: stored.field,
    baselineValue: stored.baselineValue,
    proposedValue: stored.proposedValue,
    changeType: stored.changeType,
    validationStatus: stored.validationStatus,
    validationError: stored.validationError,
    conflictStatus: stored.conflictStatus,
    approvalStatus: stored.approvalStatus,
    approvedValue: stored.approvedValue,
    createdAt: toIso(stored.createdAt),
    updatedAt: toIso(stored.updatedAt),
  };
}

function toChangeSetRecord(stored: StoredChangeSetRecord, changeList: Change[]): ChangeSet {
  const invalidCount = changeList.filter((c) => c.validationStatus === "invalid").length;
  const conflictCount = changeList.filter((c) => c.conflictStatus === "conflict").length;
  const approvedCount = changeList.filter((c) => c.approvalStatus === "approved").length;
  const rejectedCount = changeList.filter((c) => c.approvalStatus === "rejected").length;
  const pendingCount = changeList.length - approvedCount - rejectedCount;

  return {
    id: stored.id,
    channelId: stored.channelId,
    source: stored.source as ChangeSet["source"],
    status: stored.status,
    importedFilename: stored.importedFilename,
    schemaVersion: stored.schemaVersion,
    exportedAt: stored.exportedAt,
    hasInvalid: invalidCount > 0,
    hasConflicts: conflictCount > 0,
    totalChanges: changeList.length,
    pendingCount,
    approvedCount,
    rejectedCount,
    conflictCount,
    invalidCount,
    createdAt: toIso(stored.createdAt),
    updatedAt: toIso(stored.updatedAt),
  };
}

/** Builds a `(videoId, language, field) -> current remote value` lookup from the
 * latest channel-sync snapshot, or `null` per video if it is no longer synced. */
function buildCurrentRemoteLookup(videos: StoredVideoRecord[]) {
  const byVideoId = new Map(videos.map((v) => [v.videoId, v]));
  return (videoId: string, language: string, field: "title" | "description"): string | null => {
    const video = byVideoId.get(videoId);
    if (!video) return null;
    return currentRemoteValueFor(video, language, field);
  };
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

async function requireChangeSet(
  deps: ServiceDependencies,
  channelId: string,
  changeSetId: string
): Promise<StoredChangeSetRecord> {
  const changeSet = await deps.changeSetStore.getChangeSet(changeSetId);
  if (!changeSet || changeSet.channelId !== channelId) {
    throw new DomainError({
      code: "not_found",
      message: "Change set not found for this channel",
      details: { channelId, changeSetId },
    });
  }
  return changeSet;
}

/**
 * Loads a change set's changes, revalidates each one against the currently
 * synchronized remote state (conflict detection + approval invalidation, see
 * diff.ts), persists whatever changed, and recomputes/persists the change set's
 * aggregate status. This runs before every read and every mutating action so
 * approvals can never be granted against stale conflict information
 * (docs/PROJECT_SPEC.md §15).
 */
async function loadRevalidated(
  deps: ServiceDependencies,
  channelId: string,
  changeSetId: string
): Promise<{ changeSet: StoredChangeSetRecord; changes: StoredChangeRecord[] }> {
  const changeSet = await requireChangeSet(deps, channelId, changeSetId);
  const storedChanges = await deps.changeSetStore.listChangesByChangeSet(changeSetId);
  const videos = await deps.channelStore.listVideosByChannel(channelId);
  const currentRemote = buildCurrentRemoteLookup(videos);

  const revalidated = storedChanges.map((change) => {
    const current = currentRemote(change.videoId, change.language, change.field);
    const updated = revalidateChangeAgainstCurrentRemote(toChangeRecord(change), current);
    return { original: change, updated };
  });

  const dirty = revalidated.filter(
    (r) =>
      r.updated.conflictStatus !== r.original.conflictStatus ||
      r.updated.approvalStatus !== r.original.approvalStatus ||
      r.updated.approvedValue !== r.original.approvedValue
  );

  if (dirty.length > 0) {
    await deps.changeSetStore.bulkUpdateChanges(
      dirty.map((r) => ({
        id: r.original.id,
        patch: {
          conflictStatus: r.updated.conflictStatus,
          approvalStatus: r.updated.approvalStatus,
          approvedValue: r.updated.approvedValue,
        },
      }))
    );
  }

  const finalChanges: StoredChangeRecord[] = revalidated.map((r) => ({
    ...r.original,
    conflictStatus: r.updated.conflictStatus,
    approvalStatus: r.updated.approvalStatus,
    approvedValue: r.updated.approvedValue,
  }));

  const newStatus = computeChangeSetStatus(finalChanges);
  if (newStatus !== changeSet.status) {
    await deps.changeSetStore.updateChangeSetStatus(changeSetId, newStatus);
    changeSet.status = newStatus;
  }

  return { changeSet, changes: finalChanges };
}

type ChangeToPersist = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
};

/**
 * Shared persistence tail for every ChangeSet-creating entrypoint (XLSX import,
 * AI-generated proposals, and any future source): computes the aggregate status,
 * persists the ChangeSet + its Changes in one call, and reloads the stored result.
 * One creation path per AGENTS.md §D -- a new `source` must funnel through this
 * function rather than duplicating `changeSetStore.createChangeSetWithChanges` calls.
 */
async function persistChangeSet(
  deps: ServiceDependencies,
  input: {
    channelId: string;
    source: ChangeSet["source"];
    importedFilename: string | null;
    schemaVersion: string | null;
    exportedAt: string | null;
    changesToPersist: ChangeToPersist[];
  }
): Promise<ChangeSet> {
  const status = computeChangeSetStatus(
    input.changesToPersist.map((c) => ({
      validationStatus: c.validationStatus,
      conflictStatus: c.conflictStatus,
      approvalStatus: "pending" as const,
    }))
  );

  const changeSetId = deps.idGenerator();
  await deps.changeSetStore.createChangeSetWithChanges({
    id: changeSetId,
    channelId: input.channelId,
    source: input.source,
    status,
    importedFilename: input.importedFilename,
    schemaVersion: input.schemaVersion,
    exportedAt: input.exportedAt,
    changes: input.changesToPersist,
  });

  const storedChangeSet = await deps.changeSetStore.getChangeSet(changeSetId);
  if (!storedChangeSet) {
    throw new DomainError({ code: "not_found", message: "Change set disappeared after creation" });
  }
  const storedChanges = await deps.changeSetStore.listChangesByChangeSet(changeSetId);

  return toChangeSetRecord(storedChangeSet, storedChanges.map(toChangeRecord));
}

export function createChangeSetServices(deps: ServiceDependencies) {
  return {
    /**
     * Generic ChangeSet creation from a set of already-classified/validated field
     * changes, independent of where they came from. Used directly by AI Localization
     * (Phase 6) so it never reimplements ChangeSet persistence, approval, or status
     * computation -- it only produces the same `ChangeToPersist` shape XLSX import
     * produces and hands it to this one shared path.
     */
    async createChangeSetFromProposals(input: {
      channelId: string;
      source: ChangeSet["source"];
      changes: ChangeToPersist[];
    }): Promise<ChangeSet> {
      try {
        const channel = await requireChannel(deps, input.channelId);
        const changeSet = await persistChangeSet(deps, {
          channelId: channel.channelId,
          source: input.source,
          importedFilename: null,
          schemaVersion: null,
          exportedAt: null,
          changesToPersist: input.changes,
        });

        deps.logger.info({
          event: "changesets.create_from_proposals.success",
          context: { channelId: channel.channelId, changeSetId: changeSet.id, source: input.source, changeCount: input.changes.length },
        });

        return changeSet;
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "changesets.create_from_proposals.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /**
     * Proposes removing one language's localization from one or more videos (both title and
     * description per video), as a single, source:"deletion" Change Set spanning every affected
     * video -- goes through the exact same review/approval/conflict pipeline as any other change,
     * per docs/PROJECT_SPEC.md §16's 2026-09-20 update: nothing this app deletes is ever immediate
     * or bypasses multi-step confirmation, and this proposal step is the first of those steps
     * (approval is the second; the batches/ write pipeline's own gates, currently held closed by
     * Gate B, are the last). `docs/PROJECT_SPEC.md` §21 (2026-09-21): this is title/description
     * only, never any other field.
     *
     * `videoIds` omitted means "every video on the channel with a real localization in this
     * language" -- the whole-column deletion case (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md
     * §7.2/E5b). Provided explicitly, it scopes the proposal to exactly those videos (the original,
     * single-video BL-036 behavior is `videoIds: [oneId]`).
     *
     * A video whose own `defaultLanguage` equals the requested language is NEVER included in the
     * proposal, regardless of `videoIds` -- that language's title/description live on `snippet`,
     * not in the `localizations` map, and `buildSafeLocalizationsPayload` would otherwise route a
     * "delete" change for it into overwriting the video's real title/description with an empty
     * string instead of removing a localization. This check exists here (propose time) as the
     * primary defense; `buildSafeLocalizationsPayload` also refuses the same case as
     * defense-in-depth in case a delete-type change ever reaches it some other way. Such videos
     * are reported back in `skippedDefaultLanguageVideoIds`, computed independently of
     * `existingLocalizations` -- a video can have this language as its default with no
     * `localizations` entry for it at all, contributing nothing to the union `collectChannelLanguages`
     * uses, so it must never be silently dropped from the operator-facing skip count.
     *
     * Returns `changeSet: null` (not an error) when nothing is actually deletable -- e.g. every
     * candidate video has this as its defaultLanguage, or none has a real localization in it.
     */
    async proposeLocalizationDeletion(
      input: unknown
    ): Promise<{ changeSet: ChangeSet | null; affectedVideoIds: string[]; skippedDefaultLanguageVideoIds: string[] }> {
      const parsedInput = parseWithSchema(proposeLocalizationDeletionInputSchema, input, "localization deletion input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const allVideos = await deps.channelStore.listVideosByChannel(channel.channelId);

        let candidates: StoredVideoRecord[];
        if (parsedInput.videoIds) {
          const byId = new Map(allVideos.map((v) => [v.videoId, v]));
          candidates = parsedInput.videoIds.map((id) => {
            const video = byId.get(id);
            if (!video) {
              throw new DomainError({
                code: "not_found",
                message: "Video not found for this channel",
                details: { channelId: channel.channelId, videoId: id },
              });
            }
            return video;
          });
        } else {
          candidates = allVideos;
        }

        const skippedDefaultLanguageVideoIds: string[] = [];
        const affectedVideoIds: string[] = [];
        const changesToPersist: ChangeToPersist[] = [];

        for (const video of candidates) {
          if (video.defaultLanguage && parsedInput.language === video.defaultLanguage) {
            skippedDefaultLanguageVideoIds.push(video.videoId);
            continue;
          }
          const existingLocale = video.existingLocalizations[parsedInput.language];
          if (!existingLocale) continue;

          affectedVideoIds.push(video.videoId);
          for (const field of ["title", "description"] as const) {
            changesToPersist.push({
              id: deps.idGenerator(),
              videoId: video.videoId,
              language: parsedInput.language,
              field,
              baselineValue: currentRemoteValueFor(video, parsedInput.language, field),
              proposedValue: "",
              changeType: "delete",
              validationStatus: "valid",
              validationError: null,
              conflictStatus: "none",
            });
          }
        }

        if (affectedVideoIds.length === 0) {
          deps.logger.info({
            event: "changesets.propose_localization_deletion.nothing_to_propose",
            context: { channelId: channel.channelId, language: parsedInput.language, skippedDefaultLanguageVideoIds },
          });
          return { changeSet: null, affectedVideoIds, skippedDefaultLanguageVideoIds };
        }

        const changeSet = await persistChangeSet(deps, {
          channelId: channel.channelId,
          source: "deletion",
          importedFilename: null,
          schemaVersion: null,
          exportedAt: null,
          changesToPersist,
        });

        deps.logger.info({
          event: "changesets.propose_localization_deletion.success",
          context: {
            channelId: channel.channelId,
            language: parsedInput.language,
            changeSetId: changeSet.id,
            affectedVideoIds,
            skippedDefaultLanguageVideoIds,
          },
        });

        return { changeSet, affectedVideoIds, skippedDefaultLanguageVideoIds };
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "changesets.propose_localization_deletion.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async previewImport(input: unknown): Promise<{ summary: ImportSummary; errors: ImportRowError[]; totalErrors: number }> {
      const parsedInput = parseWithSchema(importWorkbookInputSchema, input, "import preview input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const videos = await deps.channelStore.listVideosByChannel(channel.channelId);
        const parsed = await parseAndValidateWorkbook({
          buffer: parsedInput.buffer,
          channelId: channel.channelId,
          syncedVideos: videos,
        });

        return {
          summary: summarizeParsedWorkbook(parsed),
          errors: parsed.errors.slice(0, MAX_PREVIEW_ERRORS_RETURNED),
          totalErrors: parsed.errors.length,
        };
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },

    async createChangeSetFromImport(
      input: unknown
    ): Promise<{ changeSet: ChangeSet; summary: ImportSummary; errors: ImportRowError[]; totalErrors: number }> {
      const parsedInput = parseWithSchema(importWorkbookInputSchema, input, "import input");

      try {
        const channel = await requireChannel(deps, parsedInput.channelId);
        const videos = await deps.channelStore.listVideosByChannel(channel.channelId);
        const parsed = await parseAndValidateWorkbook({
          buffer: parsedInput.buffer,
          channelId: channel.channelId,
          syncedVideos: videos,
        });

        const summary = summarizeParsedWorkbook(parsed);

        const changesToPersist = parsed.rows.flatMap((row) =>
          row.fields
            .filter((f) => f.changeType !== "unchanged" || f.validationStatus === "invalid")
            .map((f) => ({
              id: deps.idGenerator(),
              videoId: f.videoId,
              language: f.language,
              field: f.field,
              baselineValue: f.baselineValue,
              proposedValue: f.proposedValue,
              changeType: f.changeType,
              validationStatus: f.validationStatus,
              validationError: f.validationError,
              conflictStatus: f.conflictStatus,
            }))
        );

        const changeSet = await persistChangeSet(deps, {
          channelId: channel.channelId,
          source: "xlsx_import",
          importedFilename: parsedInput.filename,
          schemaVersion: parsed.schemaVersion,
          exportedAt: parsed.exportedAt,
          changesToPersist,
        });

        deps.logger.info({
          event: "changesets.import.success",
          context: { channelId: channel.channelId, changeSetId: changeSet.id, changeCount: changesToPersist.length },
        });

        return {
          changeSet,
          summary,
          errors: parsed.errors.slice(0, MAX_PREVIEW_ERRORS_RETURNED),
          totalErrors: parsed.errors.length,
        };
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "changesets.import.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async listChangeSets(input: unknown): Promise<ChangeSet[]> {
      const parsedInput = parseWithSchema(listChangeSetsInputSchema, input, "list change sets input");

      try {
        await requireChannel(deps, parsedInput.channelId);
        const storedSets = await deps.changeSetStore.listChangeSetsByChannel(parsedInput.channelId);

        const results: ChangeSet[] = [];
        for (const storedSet of storedSets) {
          const storedChanges = await deps.changeSetStore.listChangesByChangeSet(storedSet.id);
          results.push(toChangeSetRecord(storedSet, storedChanges.map(toChangeRecord)));
        }
        return results;
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async getChangeSet(input: unknown): Promise<{
      changeSet: ChangeSet;
      changes: Change[];
      pagination: { page: number; pageSize: number; total: number };
    }> {
      const parsedInput = parseWithSchema(getChangeSetInputSchema, input, "get change set input");

      try {
        await requireChannel(deps, parsedInput.channelId);
        const { changeSet, changes } = await loadRevalidated(deps, parsedInput.channelId, parsedInput.changeSetId);

        let filtered = changes;
        if (parsedInput.language) {
          filtered = filtered.filter((c) => c.language === parsedInput.language);
        }
        if (parsedInput.videoId) {
          filtered = filtered.filter((c) => c.videoId === parsedInput.videoId);
        }
        if (parsedInput.status && parsedInput.status !== "all") {
          if (parsedInput.status === "conflict") {
            filtered = filtered.filter((c) => c.conflictStatus === "conflict");
          } else if (parsedInput.status === "invalid") {
            filtered = filtered.filter((c) => c.validationStatus === "invalid");
          } else {
            filtered = filtered.filter((c) => c.approvalStatus === parsedInput.status);
          }
        }

        const page = parsedInput.page ?? 1;
        const pageSize = parsedInput.pageSize ?? DEFAULT_PAGE_SIZE;
        const start = (page - 1) * pageSize;
        const pageItems = filtered.slice(start, start + pageSize).map(toChangeRecord);

        return {
          changeSet: toChangeSetRecord(changeSet, changes.map(toChangeRecord)),
          changes: pageItems,
          pagination: { page, pageSize, total: filtered.length },
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async approveChange(input: unknown): Promise<{ changeSet: ChangeSet; change: Change }> {
      const parsedInput = parseWithSchema(changeActionInputSchema, input, "approve change input");

      try {
        const { changeSet, changes } = await loadRevalidated(deps, parsedInput.channelId, parsedInput.changeSetId);
        const target = changes.find((c) => c.id === parsedInput.changeId);
        if (!target) {
          throw new DomainError({ code: "not_found", message: "Change not found in this change set" });
        }
        if (target.validationStatus !== "valid" || target.conflictStatus !== "none") {
          throw new DomainError({
            code: "change_not_approvable",
            message: "Cannot approve an invalid or conflicting change; resolve it first",
            details: { changeId: target.id, validationStatus: target.validationStatus, conflictStatus: target.conflictStatus },
          });
        }
        const conflictedChangeIds = await deps.crdtConflicts.listConflictedChangeIds(parsedInput.channelId);
        if (conflictedChangeIds.has(target.id)) {
          throw new DomainError({
            code: "crdt_conflict_open",
            message: "This change has an unresolved multi-device conflict -- resolve it in the Merge tab before approving",
            details: { changeId: target.id },
          });
        }

        const patch = { approvalStatus: "approved" as const, approvedValue: target.proposedValue, conflictStatus: target.conflictStatus };
        await deps.changeSetStore.updateChange(target.id, patch);

        const updatedChanges = changes.map((c) => (c.id === target.id ? { ...c, ...patch } : c));
        const newStatus = computeChangeSetStatus(updatedChanges);
        if (newStatus !== changeSet.status) {
          await deps.changeSetStore.updateChangeSetStatus(changeSet.id, newStatus);
        }

        return {
          changeSet: toChangeSetRecord({ ...changeSet, status: newStatus }, updatedChanges.map(toChangeRecord)),
          change: toChangeRecord({ ...target, ...patch }),
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async rejectChange(input: unknown): Promise<{ changeSet: ChangeSet; change: Change }> {
      const parsedInput = parseWithSchema(changeActionInputSchema, input, "reject change input");

      try {
        const { changeSet, changes } = await loadRevalidated(deps, parsedInput.channelId, parsedInput.changeSetId);
        const target = changes.find((c) => c.id === parsedInput.changeId);
        if (!target) {
          throw new DomainError({ code: "not_found", message: "Change not found in this change set" });
        }

        const patch = { approvalStatus: "rejected" as const, approvedValue: null, conflictStatus: target.conflictStatus };
        await deps.changeSetStore.updateChange(target.id, patch);

        const updatedChanges = changes.map((c) => (c.id === target.id ? { ...c, ...patch } : c));
        const newStatus = computeChangeSetStatus(updatedChanges);
        if (newStatus !== changeSet.status) {
          await deps.changeSetStore.updateChangeSetStatus(changeSet.id, newStatus);
        }

        return {
          changeSet: toChangeSetRecord({ ...changeSet, status: newStatus }, updatedChanges.map(toChangeRecord)),
          change: toChangeRecord({ ...target, ...patch }),
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async approveAllValid(input: unknown): Promise<{ changeSet: ChangeSet; approvedCount: number }> {
      const parsedInput = parseWithSchema(changeSetBulkActionInputSchema, input, "approve-all input");

      try {
        const { changeSet, changes } = await loadRevalidated(deps, parsedInput.channelId, parsedInput.changeSetId);
        const conflictedChangeIds = await deps.crdtConflicts.listConflictedChangeIds(parsedInput.channelId);
        const toApprove = changes.filter(
          (c) =>
            c.approvalStatus === "pending" &&
            c.validationStatus === "valid" &&
            c.conflictStatus === "none" &&
            !conflictedChangeIds.has(c.id)
        );

        if (toApprove.length > 0) {
          await deps.changeSetStore.bulkUpdateChanges(
            toApprove.map((c) => ({
              id: c.id,
              patch: { approvalStatus: "approved" as const, approvedValue: c.proposedValue, conflictStatus: c.conflictStatus },
            }))
          );
        }

        const approvedIds = new Set(toApprove.map((c) => c.id));
        const updatedChanges = changes.map((c) =>
          approvedIds.has(c.id) ? { ...c, approvalStatus: "approved" as const, approvedValue: c.proposedValue } : c
        );
        const newStatus = computeChangeSetStatus(updatedChanges);
        if (newStatus !== changeSet.status) {
          await deps.changeSetStore.updateChangeSetStatus(changeSet.id, newStatus);
        }

        return {
          changeSet: toChangeSetRecord({ ...changeSet, status: newStatus }, updatedChanges.map(toChangeRecord)),
          approvedCount: toApprove.length,
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    async rejectAllPending(input: unknown): Promise<{ changeSet: ChangeSet; rejectedCount: number }> {
      const parsedInput = parseWithSchema(changeSetBulkActionInputSchema, input, "reject-all input");

      try {
        const { changeSet, changes } = await loadRevalidated(deps, parsedInput.channelId, parsedInput.changeSetId);
        const toReject = changes.filter((c) => c.approvalStatus === "pending");

        if (toReject.length > 0) {
          await deps.changeSetStore.bulkUpdateChanges(
            toReject.map((c) => ({
              id: c.id,
              patch: { approvalStatus: "rejected" as const, approvedValue: null, conflictStatus: c.conflictStatus },
            }))
          );
        }

        const rejectedIds = new Set(toReject.map((c) => c.id));
        const updatedChanges = changes.map((c) =>
          rejectedIds.has(c.id) ? { ...c, approvalStatus: "rejected" as const, approvedValue: null } : c
        );
        const newStatus = computeChangeSetStatus(updatedChanges);
        if (newStatus !== changeSet.status) {
          await deps.changeSetStore.updateChangeSetStatus(changeSet.id, newStatus);
        }

        return {
          changeSet: toChangeSetRecord({ ...changeSet, status: newStatus }, updatedChanges.map(toChangeRecord)),
          rejectedCount: toReject.length,
        };
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },
  };
}

export type ChangeSetServices = ReturnType<typeof createChangeSetServices>;
export { classifyRowForSummary };
