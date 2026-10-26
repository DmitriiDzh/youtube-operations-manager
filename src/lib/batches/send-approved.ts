import { sameLanguage } from "@/lib/shared-language-baseline";
import { untitledTranslations } from "@/lib/shared-localization-merge";
import { languageKey, mergeCollision } from "./targets";
import { UNITS_PER_WRITTEN_VIDEO } from "@/lib/quota-guard";
import { DomainError, TERMINAL_LEDGER_STATUSES, type Batch, type LedgerRow } from "./contracts";
import { isApprovalStillValid } from "./services";
import type { SendableChangeCandidate } from "./adapters/store";

/**
 * BL-124 / ADR 0020: the server half of the one-click "send approved changes" button.
 * BL-198 (docs/roadmap/plans/SEND_TOGETHER_PLAN.md): the same for several change sets at once -- one row per video carrying
 * every selected set's sendable changes, so a video costs one write whatever the number of languages.
 *
 * It only SELECTS and CREATES: from stored change sets it picks the sendable changes (approved + valid +
 * no conflict + the frozen approval still matching the proposed value) and creates a batch from them
 * through the existing `createBatch`. It never executes anything and never references a write executor --
 * the write itself still goes through the existing execute route / `executeBatch` / the single write
 * gateway, with every safeguard unchanged (`write-path-inventory.test.ts` stays green without a new entry).
 */
export type SendApprovedDeps = {
  /** The persisted Settings-tab Live writes toggle. Read FIRST: with it off nothing is created. */
  isLiveWritesEnabled(): Promise<boolean>;
  batches: {
    createBatch(input: {
      channelId: string;
      selections: Array<{ videoId: string; changeIds: string[] }>;
      dryRun: boolean;
    }): Promise<Batch>;
    listBatchesByChannel(channelId: string): Promise<Batch[]>;
    listLedgerRows(batchId: string): Promise<LedgerRow[]>;
    /** BL-198: the MERGE audit events of a batch made from several sets. */
    recordMergeAudit?(batchId: string, rows: Array<{ videoId: string; detail: unknown }>): Promise<void>;
  };
  changeSets: {
    getChangeSet(changeSetId: string): Promise<{ id: string; channelId: string; source?: string; createdAt?: string } | null>;
    listChanges(changeSetId: string): Promise<SendableChangeCandidate[]>;
    /** BL-198: rejects the variant the owner did not keep (through the change-set service: status recomputed, reversible by approving again). */
    rejectChange?(input: { channelId: string; changeSetId: string; changeId: string }): Promise<void>;
    /** BL-198: video titles for the conflict window. */
    videoTitles?(channelId: string): Promise<Map<string, string>>;
    /**
     * BL-198: read once per call -- whether the channel's synced copy already holds a change's approved value (a delete: the
     * language is gone). Absent = no change counts as held.
     */
    remoteHolds?(channelId: string): Promise<(change: SendableChangeCandidate) => boolean>;
    /**
     * BL-226: read once per call -- per video of the channel's synced copy (read against its language baseline), whether a language
     * is the video's own and the title it has in a language now. `null` for a video that is not synced (the write checks it then).
     * Absent = no check before the write.
     */
    currentTitles?(channelId: string): Promise<(videoId: string) => { isOwnLanguage(language: string): boolean; title(language: string): string } | null>;
  };
};

export type SendApprovedResult = { batch: Batch; changeCount: number; videoCount: number };

export function selectSendableChanges(changes: SendableChangeCandidate[]): SendableChangeCandidate[] {
  return changes.filter(
    (change) =>
      change.approvalStatus === "approved" &&
      change.validationStatus === "valid" &&
      change.conflictStatus === "none" &&
      isApprovalStillValid(change)
  );
}

/**
 * Whether an approved change is already on YouTube (BL-198 plan, "Definitions"): a SUCCESS row of a real (non-dry-run) batch at least
 * as new as the change's last update, or the channel's last synced copy already holding the approved value (a delete: the language
 * is gone). The second part covers a change whose `updatedAt` moved after its write without a new value (seen on real data).
 */
export function isChangeWritten(change: SendableChangeCandidate, writtenAtByChangeId: Map<string, number>): boolean {
  const writtenAt = writtenAtByChangeId.get(change.id);
  if (writtenAt !== undefined && writtenAt >= Date.parse(change.updatedAt)) return true;
  return change.remoteHolds === true;
}

/** Changes already written are not sent a second time (AC-SEND-13, AC-ST-09). */
function excludeAlreadyWritten(changes: SendableChangeCandidate[], writtenAtByChangeId: Map<string, number>): SendableChangeCandidate[] {
  return changes.filter((change) => !isChangeWritten(change, writtenAtByChangeId));
}

export type MergeConflictOption = {
  changeSetId: string;
  source: string | null;
  createdAt: string | null;
  changes: Array<{ changeId: string; field: string; changeType: string; proposedValue: string }>;
};
/**
 * One decision for the owner: a field of a video's language (`field` set) changed by several sets, or -- when one of them deletes the
 * language -- the whole language (`field` null).
 */
export type MergeConflict = { videoId: string; videoTitle: string | null; language: string; field: string | null; options: MergeConflictOption[] };
/** For each conflict unit, the set whose variant is kept. */
export type MergeResolution = { videoId: string; language: string; field?: string | null; changeSetId: string };

/** BL-226: a translation the send would leave without a title (YouTube would refuse that whole video). */
export type UntitledTranslation = { videoId: string; videoTitle: string | null; language: string };

export type SendTogetherPlan = {
  videoCount: number;
  changeCount: number;
  languageCount: number;
  estimatedUnits: number;
  conflicts: MergeConflict[];
  /** BL-226: translations without a title among these changes -- the send is refused until each is fixed. */
  untitled: UntitledTranslation[];
  /** A live batch not yet finished already holds some of these changes (ADR 0020 §5). */
  inFlightBatchId: string | null;
  /** Whether that batch holds every change of this selection (then it can simply be continued). */
  inFlightCoversSelection: boolean;
};

export type SendTogetherResult = SendApprovedResult & { rejectedChangeIds: string[] };

type Tagged = SendableChangeCandidate & { fromSet: string };
type ConflictUnit = { videoId: string; language: string; field: string | null; changes: Tagged[] };

function unitKey(videoId: string, language: string | undefined, field: string | null | undefined): string {
  return `${videoId}\u0000${languageKey(language)}\u0000${field ?? "*"}`;
}

/** Whether `change` is inside a unit's scope: its field, or anything of the language for a whole-language unit. */
function inScope(unit: { field: string | null }, change: SendableChangeCandidate): boolean {
  return unit.field === null || change.changeType === "delete" || change.field === unit.field;
}

/**
 * The decisions a selection needs. Per (video, language): when a delete collides with another set's change, the whole language is one
 * unit (a delete covers both fields); otherwise each field changed by two or more sets is its own unit, so the owner can keep one
 * set's title and another set's description.
 */
function findConflictUnits(changes: Tagged[]): ConflictUnit[] {
  const byLanguage = new Map<string, Tagged[]>();
  for (const change of changes) {
    if (!change.language) continue;
    const key = unitKey(change.videoId, change.language, null);
    const list = byLanguage.get(key) ?? [];
    list.push(change);
    byLanguage.set(key, list);
  }
  const units: ConflictUnit[] = [];
  for (const list of byLanguage.values()) {
    const crossSet = (filter: (a: Tagged, b: Tagged) => boolean) =>
      list.some((a, i) => list.some((b, j) => j > i && a.fromSet !== b.fromSet && mergeCollision(a, b) && filter(a, b)));
    const { videoId, language } = list[0] as { videoId: string; language: string };
    if (crossSet((a, b) => a.changeType === "delete" || b.changeType === "delete")) {
      units.push({ videoId, language, field: null, changes: list });
      continue;
    }
    for (const field of ["title", "description"]) {
      const inField = list.filter((change) => change.field === field);
      if (new Set(inField.map((change) => change.fromSet)).size > 1) units.push({ videoId, language, field, changes: inField });
    }
  }
  return units;
}

type SetInfo = { id: string; source: string | null; createdAt: string | null };

export function createSendApprovedServices(deps: SendApprovedDeps) {
  // Creation is serialized per channel in this process (the server is one Node process), so two clicks
  // arriving together cannot both pass the "already in flight" check before either has created its batch.
  const tails = new Map<string, Promise<unknown>>();

  function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  async function findInFlightBatch(channelId: string, changeIds: Set<string>): Promise<{ batchId: string; covers: boolean } | null> {
    const batches = await deps.batches.listBatchesByChannel(channelId);
    for (const batch of batches) {
      if (batch.dryRun || (batch.status !== "PENDING" && batch.status !== "RUNNING")) continue;
      const rows = await deps.batches.listLedgerRows(batch.id);
      const held = new Set(rows.filter((row) => !TERMINAL_LEDGER_STATUSES.has(row.status)).flatMap((row) => row.changeIds));
      if ([...changeIds].some((id) => held.has(id))) return { batchId: batch.id, covers: [...changeIds].every((id) => held.has(id)) };
    }
    return null;
  }

  async function writtenAtByChangeId(channelId: string): Promise<Map<string, number>> {
    const writtenAt = new Map<string, number>();
    for (const batch of await deps.batches.listBatchesByChannel(channelId)) {
      if (batch.dryRun) continue;
      for (const row of await deps.batches.listLedgerRows(batch.id)) {
        if (row.status !== "SUCCESS") continue;
        const at = Date.parse(row.updatedAt);
        for (const id of row.changeIds) writtenAt.set(id, Math.max(writtenAt.get(id) ?? 0, at));
      }
    }
    return writtenAt;
  }

  /** The selection's sendable, not yet written changes, each tagged with its set; refuses unknown sets and sets of another channel. */
  async function gather(channelId: string, changeSetIds: string[], videoIds?: string[]): Promise<{ sets: SetInfo[]; changes: Tagged[] }> {
    // BL-227: `videoIds` keeps only those videos' changes (a send from the review screen of one video); an empty list sends nothing.
    if (videoIds !== undefined && videoIds.length === 0) {
      throw new DomainError({ code: "validation_failed", message: "videoIds must name at least one video", details: { videoIds } });
    }
    const onlyVideos = videoIds ? new Set(videoIds) : null;
    const sets: SetInfo[] = [];
    const changes: Tagged[] = [];
    const written = await writtenAtByChangeId(channelId);
    const holds = deps.changeSets.remoteHolds ? await deps.changeSets.remoteHolds(channelId) : null;
    for (const changeSetId of [...new Set(changeSetIds)]) {
      const changeSet = await deps.changeSets.getChangeSet(changeSetId);
      if (!changeSet || changeSet.channelId !== channelId) {
        throw new DomainError({
          code: "not_found",
          message: `Change set ${changeSetId} not found for this channel`,
          details: { changeSetId },
        });
      }
      sets.push({ id: changeSet.id, source: changeSet.source ?? null, createdAt: changeSet.createdAt ?? null });
      const listed = (await deps.changeSets.listChanges(changeSetId)).map((change) => (holds ? { ...change, remoteHolds: holds(change) } : change));
      for (const change of excludeAlreadyWritten(selectSendableChanges(listed), written)) {
        if (onlyVideos && !onlyVideos.has(change.videoId)) continue;
        changes.push({ ...change, fromSet: changeSetId });
      }
    }
    return { sets, changes };
  }

  async function describeConflicts(channelId: string, sets: SetInfo[], units: ConflictUnit[]): Promise<MergeConflict[]> {
    if (units.length === 0) return [];
    const titles = deps.changeSets.videoTitles ? await deps.changeSets.videoTitles(channelId) : new Map<string, string>();
    return units.map((unit) => ({
      videoId: unit.videoId,
      videoTitle: titles.get(unit.videoId) ?? null,
      language: unit.language,
      field: unit.field,
      options: sets
        .filter((set) => unit.changes.some((change) => change.fromSet === set.id))
        .map((set) => ({
          changeSetId: set.id,
          source: set.source,
          createdAt: set.createdAt,
          changes: unit.changes
            .filter((change) => change.fromSet === set.id)
            .map((change) => ({ changeId: change.id, field: change.field ?? "", changeType: change.changeType ?? "", proposedValue: change.proposedValue })),
        })),
    }));
  }

  /** BL-226: per video, the languages these changes would leave without a title (the shared rule, against the synced copy). */
  async function findUntitled(channelId: string, changes: SendableChangeCandidate[]): Promise<UntitledTranslation[]> {
    if (!deps.changeSets.currentTitles || changes.length === 0) return [];
    const current = await deps.changeSets.currentTitles(channelId);
    const byVideo = new Map<string, SendableChangeCandidate[]>();
    for (const change of changes) byVideo.set(change.videoId, [...(byVideo.get(change.videoId) ?? []), change]);
    const found: Array<{ videoId: string; language: string }> = [];
    for (const [videoId, list] of byVideo) {
      const read = current(videoId);
      if (!read) continue;
      const fieldChanges = list.flatMap((change) =>
        change.language && change.field
          ? [{ language: change.language, field: change.field, proposedValue: change.proposedValue, changeType: change.changeType as "add" | "modify" | "unchanged" | "delete" | undefined }]
          : []
      );
      for (const language of untitledTranslations(read, fieldChanges)) found.push({ videoId, language });
    }
    if (found.length === 0) return [];
    const titles = deps.changeSets.videoTitles ? await deps.changeSets.videoTitles(channelId) : new Map<string, string>();
    return found.map((entry) => ({ ...entry, videoTitle: titles.get(entry.videoId) ?? null }));
  }

  function groupByVideo(changes: SendableChangeCandidate[]): Map<string, string[]> {
    const byVideo = new Map<string, string[]>();
    for (const change of changes) {
      const ids = byVideo.get(change.videoId) ?? [];
      ids.push(change.id);
      byVideo.set(change.videoId, ids);
    }
    return byVideo;
  }

  /** BL-198 (AC-ST-01): read only -- what a send of these sets would create, and what must be decided first. */
  async function planSendTogether(input: { channelId: string; changeSetIds: string[]; videoIds?: string[] }): Promise<SendTogetherPlan> {
    const { sets, changes } = await gather(input.channelId, input.changeSetIds, input.videoIds);
    const units = findConflictUnits(changes);
    // Changes in a conflict unit may still lose; the in-flight check (like the create path's) looks at the ones that surely go in.
    const contested = new Set(units.flatMap((unit) => unit.changes.map((change) => change.id)));
    const sure = changes.filter((change) => !contested.has(change.id));
    const inFlight = sure.length > 0 ? await findInFlightBatch(input.channelId, new Set(sure.map((change) => change.id))) : null;
    const videoCount = new Set(changes.map((change) => change.videoId)).size;
    return {
      videoCount,
      changeCount: changes.length,
      languageCount: new Set(changes.map((change) => languageKey(change.language))).size,
      estimatedUnits: videoCount * UNITS_PER_WRITTEN_VIDEO,
      conflicts: await describeConflicts(input.channelId, sets, units),
      untitled: await findUntitled(input.channelId, changes),
      inFlightBatchId: inFlight?.batchId ?? null,
      inFlightCoversSelection: inFlight?.covers ?? false,
    };
  }

  /**
   * BL-198: one batch from several change sets (one set: ADR 0020's send, unchanged). A collision between sets must be resolved by the
   * owner (`resolutions`): the kept set's changes go in; on a live send the colliding changes of the other sets are rejected first, so
   * they can never be sent later over the kept ones (reversible: approve again). A dry run rejects nothing, it only leaves them out.
   */
  async function createBatchForChangeSets(input: {
    channelId: string;
    changeSetIds: string[];
    resolutions?: MergeResolution[];
    dryRun?: boolean;
    /** BL-227: only these videos' changes. */
    videoIds?: string[];
  }): Promise<SendTogetherResult> {
    const dryRun = input.dryRun === true;
    // AC-SEND-02 / AC-ST-07: with Live writes off a live send refuses before touching anything, so no batch row is left behind
    // and nothing is rejected (the execute route re-checks the same toggle independently, Layer 1 and Layer 2).
    if (!dryRun && !(await deps.isLiveWritesEnabled())) {
      throw new DomainError({
        code: "live_writes_disabled",
        message: "Live writes is off -- nothing was sent. Turn on \"Live writes\" in Settings first.",
      });
    }

    return serialized(input.channelId, async () => {
      const { sets, changes } = await gather(input.channelId, input.changeSetIds, input.videoIds);
      // Changes a real batch already wrote (and that were not edited since) are not sent a second time: that would only spend quota and a backup
      // to hit the pre-write conflict check against the value that is already live (AC-SEND-13).
      if (changes.length === 0) {
        throw new DomainError({
          code: "send_nothing_to_send",
          message: "This change set has no approved, valid, conflict-free changes left to send (changes already written are not sent again).",
          details: sets.length === 1 ? { changeSetId: sets[0].id } : { changeSetIds: sets.map((set) => set.id) },
        });
      }

      // AC-ST-02 / AC-ST-14: every collision needs a resolution naming one of its own sets.
      const units = findConflictUnits(changes);
      const kept = new Map<string, string>();
      for (const unit of units) {
        const resolution = (input.resolutions ?? []).find(
          (r) => r.videoId === unit.videoId && sameLanguage(r.language, unit.language) && (r.field ?? null) === unit.field
        );
        if (!resolution) continue;
        if (!unit.changes.some((change) => change.fromSet === resolution.changeSetId)) {
          throw new DomainError({
            code: "validation_failed",
            message: `The resolution for video ${unit.videoId}, language ${unit.language} names a change set that has no change there.`,
            details: { videoId: unit.videoId, language: unit.language, field: unit.field, changeSetId: resolution.changeSetId },
          });
        }
        kept.set(unitKey(unit.videoId, unit.language, unit.field), resolution.changeSetId);
      }
      const unresolved = units.filter((unit) => !kept.has(unitKey(unit.videoId, unit.language, unit.field)));
      if (unresolved.length > 0) {
        throw new DomainError({
          code: "send_merge_conflicts",
          message: "Several selected change sets change the same fields. Choose which variant to send for each of them.",
          details: { conflicts: await describeConflicts(input.channelId, sets, unresolved) },
        });
      }

      // The losers: in each unit, every change of another set that collides with a change of the kept set.
      const loserIds = new Set<string>();
      for (const unit of units) {
        const keptSet = kept.get(unitKey(unit.videoId, unit.language, unit.field));
        const keptChanges = unit.changes.filter((change) => change.fromSet === keptSet && inScope(unit, change));
        for (const change of unit.changes) {
          if (change.fromSet !== keptSet && inScope(unit, change) && keptChanges.some((k) => mergeCollision(k, change))) loserIds.add(change.id);
        }
      }
      const losers = changes.filter((change) => loserIds.has(change.id));
      const selected = changes.filter((change) => !loserIds.has(change.id));
      // Review of BL-198: nothing is rejected before the final selection is known to make a valid batch -- no two sets still
      // colliding in one row.
      const leftover = findConflictUnits(selected);
      if (leftover.length > 0) {
        throw new DomainError({
          code: "send_merge_conflicts",
          message: "These choices still leave two change sets changing the same place. Choose again.",
          details: { conflicts: await describeConflicts(input.channelId, sets, leftover) },
        });
      }

      // BL-226: a translation left without a title would make YouTube refuse its whole video -- refused here, before anything is
      // rejected or created, naming each one (the owner approves a title or rejects the description, then sends again).
      const untitled = await findUntitled(input.channelId, selected);
      if (untitled.length > 0) {
        throw new DomainError({
          code: "send_untitled_translations",
          message: `Nothing was sent: ${untitled.map((entry) => `${entry.videoId} (${entry.language})`).join(", ")} would get a translation without a title, and YouTube refuses the whole video then. Approve a title for that language or reject its description, then send again.`,
          details: { untitled },
        });
      }

      const inFlight = await findInFlightBatch(input.channelId, new Set(selected.map((change) => change.id)));
      if (inFlight) {
        throw new DomainError({
          code: "send_already_in_progress",
          message: "These changes are already part of a live batch that has not finished.",
          // One set: ADR 0020's details, unchanged; several: which sets, and whether that batch already holds all of them.
          details:
            sets.length === 1
              ? { batchId: inFlight.batchId, changeSetId: sets[0].id }
              : { batchId: inFlight.batchId, changeSetIds: sets.map((set) => set.id), coversSelection: inFlight.covers },
        });
      }

      if (!dryRun && losers.length > 0) {
        if (!deps.changeSets.rejectChange) throw new Error("rejectChange is not wired");
        for (const loser of losers) {
          await deps.changeSets.rejectChange({ channelId: input.channelId, changeSetId: loser.fromSet, changeId: loser.id });
        }
      }

      const byVideo = groupByVideo(selected);
      const batch = await deps.batches.createBatch({
        channelId: input.channelId,
        selections: [...byVideo.entries()].map(([videoId, changeIds]) => ({ videoId, changeIds })),
        dryRun,
      });

      if (sets.length > 1 && deps.batches.recordMergeAudit) {
        await deps.batches.recordMergeAudit(
          batch.id,
          [...byVideo.keys()].map((videoId) => {
            const videoLosers = losers.filter((change) => change.videoId === videoId).map((change) => change.id);
            return {
              videoId,
              detail: {
                changeSetIds: [...new Set(selected.filter((change) => change.videoId === videoId).map((change) => change.fromSet))],
                kept: units
                  .filter((unit) => unit.videoId === videoId)
                  .map((unit) => ({ language: unit.language, field: unit.field, changeSetId: kept.get(unitKey(unit.videoId, unit.language, unit.field)) })),
                rejectedChangeIds: dryRun ? [] : videoLosers,
                leftOutChangeIds: dryRun ? videoLosers : [],
              },
            };
          })
        );
      }

      return { batch, changeCount: selected.length, videoCount: byVideo.size, rejectedChangeIds: dryRun ? [] : losers.map((change) => change.id) };
    });
  }

  /** ADR 0020: one set, live. The same service with one id (one set has no collisions between sets). */
  async function createLiveBatchForChangeSet(input: { channelId: string; changeSetId: string }): Promise<SendApprovedResult> {
    const { batch, changeCount, videoCount } = await createBatchForChangeSets({ channelId: input.channelId, changeSetIds: [input.changeSetId] });
    return { batch, changeCount, videoCount };
  }

  /**
   * BL-198 (AC-ST-12): per change set, its approved changes and how many of them are written -- «Записаны в YouTube» when every
   * approved change is written, «Одобренные» (waiting to be sent) otherwise.
   */
  async function writtenCountsByChangeSet(channelId: string, changeSetIds: string[]): Promise<Map<string, { approvedCount: number; writtenCount: number }>> {
    const written = await writtenAtByChangeId(channelId);
    const holds = deps.changeSets.remoteHolds ? await deps.changeSets.remoteHolds(channelId) : null;
    const counts = new Map<string, { approvedCount: number; writtenCount: number }>();
    for (const changeSetId of changeSetIds) {
      const approved = (await deps.changeSets.listChanges(changeSetId))
        .filter((change) => change.approvalStatus === "approved")
        .map((change) => (holds ? { ...change, remoteHolds: holds(change) } : change));
      counts.set(changeSetId, { approvedCount: approved.length, writtenCount: approved.filter((change) => isChangeWritten(change, written)).length });
    }
    return counts;
  }

  /** BL-227: the approved changes of these sets that are already on YouTube (the same rule as `writtenCountsByChangeSet`). */
  async function writtenChangeIds(channelId: string, changeSetIds: string[]): Promise<Set<string>> {
    const written = await writtenAtByChangeId(channelId);
    const holds = deps.changeSets.remoteHolds ? await deps.changeSets.remoteHolds(channelId) : null;
    const ids = new Set<string>();
    for (const changeSetId of changeSetIds) {
      for (const change of await deps.changeSets.listChanges(changeSetId)) {
        if (change.approvalStatus !== "approved") continue;
        if (isChangeWritten(holds ? { ...change, remoteHolds: holds(change) } : change, written)) ids.add(change.id);
      }
    }
    return ids;
  }

  return { createLiveBatchForChangeSet, createBatchForChangeSets, planSendTogether, writtenCountsByChangeSet, writtenChangeIds };
}

export type SendApprovedServices = ReturnType<typeof createSendApprovedServices>;
