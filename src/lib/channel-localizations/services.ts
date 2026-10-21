import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { sameLanguage } from "@/lib/shared-language-baseline";
import { buildSafeLocalizationsPayload, localeKeyFor } from "@/lib/shared-localization-merge";
import { pickSettableBrandingChannelFields } from "@/lib/youtube-write-gateway";
import { DomainError, isDomainError, type ChannelLocalizationsActor, type ChannelLocalizationsDependencies, type ChannelLocalizationsLastApply, type ChannelLocalizationsPreviewView, type ChannelLocalizationsView } from "./contracts";
import { previewChannelLocalizations, readStoredChannelLocalizations, validateChannelLocalizations, type ChannelLocalizationSet, type LiveChannelLocalizations } from "./set";

/** Up to 4 reads, 5 s apart, while the channel does not yet show what was written. */
export const CHANNEL_LOCALIZATIONS_READ_BACK = { attempts: 4, delayMs: 5_000 };

const PROBLEM_ERRORS = {
  empty_set: { code: "validation_failed", message: "No translations are saved for this channel: nothing to apply" },
  no_baseline: { code: "no_baseline", message: "The channel has no default language on YouTube and no base language is set here: set the channel's base language first" },
  default_language_mismatch: { code: "default_language_mismatch", message: "The channel's two default-language fields on YouTube disagree: nothing was written" },
  own_language_in_set: { code: "validation_failed", message: "The translations hold the channel's own language (its text is the base title and description): remove it" },
} as const;

const brandingJson = (channel: Record<string, unknown>) => JSON.stringify(Object.entries(pickSettableBrandingChannelFields(channel)).sort(([a], [b]) => a.localeCompare(b)));
const localizationsJson = (localizations: LiveChannelLocalizations["localizations"]) =>
  JSON.stringify(Object.keys(localizations).sort().map((key) => [key, localizations[key].title, localizations[key].description]));

/** Whether a second read differs from the first in anything a write sends back or must keep. */
function changedBetweenReads(second: LiveChannelLocalizations, first: LiveChannelLocalizations): boolean {
  return (
    second.snippet.title !== first.snippet.title ||
    second.snippet.description !== first.snippet.description ||
    (second.snippet.defaultLanguage ?? null) !== (first.snippet.defaultLanguage ?? null) ||
    brandingJson(second.brandingChannel) !== brandingJson(first.brandingChannel) ||
    localizationsJson(second.localizations) !== localizationsJson(first.localizations)
  );
}

/** After the `brandingSettings` write: the default language is the one sent, every other settable field and the base text as read. */
function brandingProblem(after: LiveChannelLocalizations, before: LiveChannelLocalizations, defaultLanguage: string): string | null {
  const problems: string[] = [];
  const readDefault = typeof after.brandingChannel.defaultLanguage === "string" ? after.brandingChannel.defaultLanguage : null;
  if (!sameLanguage(readDefault, defaultLanguage)) problems.push("default language not set");
  const fields = new Set([...Object.keys(pickSettableBrandingChannelFields(before.brandingChannel)), ...Object.keys(pickSettableBrandingChannelFields(after.brandingChannel))]);
  fields.delete("defaultLanguage");
  const changed = [...fields].filter((field) => JSON.stringify(after.brandingChannel[field] ?? null) !== JSON.stringify(before.brandingChannel[field] ?? null));
  if (changed.length > 0) problems.push(`branding field changed: ${changed.sort().join(", ")}`);
  if (after.snippet.title !== before.snippet.title || after.snippet.description !== before.snippet.description) problems.push("the base title or description changed");
  return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * After the `localizations` write: every written language exactly as sent, every other language as it was (the own-language entry
 * aside: the merge never sends it), the base text, the default language and the branding fields unchanged.
 */
function localizationsProblem(after: LiveChannelLocalizations, before: LiveChannelLocalizations, set: ChannelLocalizationSet, ownLanguage: string): string | null {
  const problems: string[] = [];
  if (after.snippet.title !== before.snippet.title || after.snippet.description !== before.snippet.description) problems.push("the base title or description changed");
  if (brandingJson(after.brandingChannel) !== brandingJson(before.brandingChannel)) problems.push("branding settings changed");
  const missing: string[] = [];
  const differs: string[] = [];
  for (const [language, value] of Object.entries(set)) {
    const key = localeKeyFor(after.localizations, language);
    if (key === null) missing.push(language);
    else if (after.localizations[key].title !== value.title || after.localizations[key].description !== value.description) differs.push(language);
  }
  const lost: string[] = [];
  const otherChanged: string[] = [];
  for (const [language, value] of Object.entries(before.localizations)) {
    if (sameLanguage(language, ownLanguage) || Object.keys(set).some((written) => sameLanguage(written, language))) continue;
    const key = localeKeyFor(after.localizations, language);
    if (key === null) lost.push(language);
    else if (after.localizations[key].title !== value.title || after.localizations[key].description !== value.description) otherChanged.push(language);
  }
  if (missing.length > 0) problems.push(`language missing: ${missing.join(", ")}`);
  if (differs.length > 0) problems.push(`text differs: ${differs.join(", ")}`);
  if (lost.length > 0) problems.push(`language lost: ${lost.join(", ")}`);
  if (otherChanged.length > 0) problems.push(`other language changed: ${otherChanged.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : null;
}

function parseLastApply(json: string | null | undefined): ChannelLocalizationsLastApply | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ChannelLocalizationsLastApply;
  } catch {
    return null;
  }
}

export function createChannelLocalizationsService(deps: ChannelLocalizationsDependencies) {
  const { attempts, delayMs } = deps.readBack ?? CHANNEL_LOCALIZATIONS_READ_BACK;

  async function connectedChannel(channelId: string): Promise<{ connectedUserId: string | null }> {
    const channel = await deps.channel(channelId);
    if (!channel) throw new DomainError({ code: "channel_not_connected", message: "This channel is not connected on this computer", details: { channelId } });
    return channel;
  }

  async function storedSet(channelId: string): Promise<{ set: ChannelLocalizationSet | null; problem: string | null; row: Awaited<ReturnType<ChannelLocalizationsDependencies["store"]["get"]>> }> {
    const row = await deps.store.get(channelId);
    const stored = readStoredChannelLocalizations(row?.localizationsJson);
    return { set: stored.ok ? stored.set : null, problem: stored.ok ? null : stored.problem, row };
  }

  async function readLive(credentials: Parameters<ChannelLocalizationsDependencies["youtube"]["read"]>[0], channelId: string): Promise<LiveChannelLocalizations> {
    const live = await deps.youtube.read(credentials, channelId);
    if (!live) throw new DomainError({ code: "not_found", message: "YouTube does not return the channel", details: { channelId } });
    return live;
  }

  /** A read with the channel's own connected account (1 unit). */
  async function readWithChannelAccount(channelId: string): Promise<LiveChannelLocalizations> {
    const channel = await connectedChannel(channelId);
    if (!channel.connectedUserId) throw new DomainError({ code: "channel_not_connected", message: "The channel has no connected account", details: { channelId } });
    const credentials = await deps.auth.resolve({ credentialRef: { userId: channel.connectedUserId }, requiredScopes: [YOUTUBE_READ_SCOPE] });
    return readLive(credentials, channelId);
  }

  async function recordLastApply(channelId: string, result: ChannelLocalizationsLastApply): Promise<void> {
    await deps.store.saveLastApply(channelId, { lastApplyJson: JSON.stringify(result), lastApplyAt: new Date(result.at) });
  }

  const service = {
    /** The stored set, the baseline and the last apply (local only). */
    async view(channelId: string): Promise<ChannelLocalizationsView> {
      await connectedChannel(channelId);
      const { set, problem, row } = await storedSet(channelId);
      return {
        channelId,
        localizations: set,
        problem,
        baselineLanguage: await deps.baselineLanguage(channelId),
        updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        updatedBy: row?.updatedBy === "owner" || row?.updatedBy === "factory" ? row.updatedBy : null,
        lastApply: parseLastApply(row?.lastApplyJson),
      };
    },

    /**
     * Local only (AC-CL-01): the set replaces the stored one; an empty set clears it. Any refused language refuses the whole call
     * (`validation_failed`, `details.refused`) and nothing is stored (AC-CL-02). Nothing is sent to YouTube.
     */
    async save(channelId: string, input: unknown, by: ChannelLocalizationsActor): Promise<{ localizations: ChannelLocalizationSet }> {
      await connectedChannel(channelId);
      const result = validateChannelLocalizations(input, { baselineLanguage: await deps.baselineLanguage(channelId) });
      if (!result.ok) {
        throw new DomainError({ code: "validation_failed", message: result.message, details: { channelId, problem: result.problem, refused: result.refused } });
      }
      const languages = Object.keys(result.set);
      await deps.store.saveSet(channelId, { localizationsJson: languages.length > 0 ? JSON.stringify(result.set) : null, updatedAt: deps.clock(), updatedBy: by });
      await deps.audit.record({ channelId, kind: "saved", detail: { languages, by } });
      return { localizations: result.set };
    },

    /** The channel's translations on YouTube now (1-unit read with the channel's account), for the Operator and the card. */
    async live(channelId: string): Promise<{ defaultLanguage: string | null; localizations: LiveChannelLocalizations["localizations"] }> {
      const live = await readWithChannelAccount(channelId);
      const brandingDefault = typeof live.brandingChannel.defaultLanguage === "string" && live.brandingChannel.defaultLanguage ? live.brandingChannel.defaultLanguage : null;
      return { defaultLanguage: brandingDefault ?? live.snippet.defaultLanguage, localizations: live.localizations };
    },

    /** What Apply would do now (1-unit read; nothing is written). */
    async preview(channelId: string): Promise<ChannelLocalizationsPreviewView> {
      const { set } = await storedSet(channelId);
      const live = await readWithChannelAccount(channelId);
      return { ...previewChannelLocalizations(set, live, await deps.baselineLanguage(channelId)), live: live.localizations };
    },

    /**
     * The owner's «Применить» (AGENTS.md §G): identity, a fresh read, the preview's problems refused, a backup, the channel unchanged
     * right before the writes, the default language first when it is missing (its own write), the safe merge, Live writes right
     * before each write, read-backs, the audit and the last result.
     */
    async apply(channelId: string, credentialRef: unknown): Promise<ChannelLocalizationsLastApply> {
      let backupPath: string | null = null;
      let writes = 0;
      let defaultLanguageSet: string | null = null;
      let languages: string[] = [];
      await connectedChannel(channelId);
      try {
        const { set, problem } = await storedSet(channelId);
        if (problem) throw new DomainError({ code: "validation_failed", message: `The saved translations cannot be applied: ${problem}`, details: { channelId } });

        // 1. Identity: the account is the channel's (fails closed, AC-CL-05).
        const credentials = await deps.auth.resolve({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
        await deps.writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });

        // 2. A fresh read and what it means (AC-CL-09: no default language and no baseline -> refused before any write).
        const fresh = await readLive(credentials, channelId);
        const preview = previewChannelLocalizations(set, fresh, await deps.baselineLanguage(channelId));
        const first = preview.problems[0];
        if (first) throw new DomainError({ ...PROBLEM_ERRORS[first], details: { channelId, problems: preview.problems } });
        const stored = set as ChannelLocalizationSet;
        const ownLanguage = preview.ownLanguage as string;
        languages = preview.languages.filter((l) => l.status !== "unchanged").map((l) => l.language);
        if (preview.quota.writes === 0) {
          const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: true, languages: [], defaultLanguageSet: null, writes: 0, backupPath: null };
          await deps.audit.record({ channelId, kind: "verification", detail: { verified: true, nothingToWrite: true } });
          await recordLastApply(channelId, result);
          return result;
        }

        // 3. Backup of the channel exactly as read.
        const health = await deps.backup.checkInfrastructureHealth();
        if (!health.healthy) throw new DomainError({ code: "backup_infrastructure_unavailable", message: health.error ?? "Backup storage is unreachable" });
        const backup = await deps.backup.captureBackup({
          channelId,
          operationId: deps.newId(),
          subjectId: channelId,
          snapshot: { kind: "channel_localizations", snippet: fresh.snippet, brandingChannel: fresh.brandingChannel, localizations: fresh.localizations },
        });
        backupPath = backup.path;
        await deps.audit.record({ channelId, kind: "backup", detail: { backupPath } });

        // 4. Right before the writes: the channel still reads as the read the writes are built from (an edit made in Studio
        // meanwhile would be undone by a part sent whole).
        if (changedBetweenReads(await readLive(credentials, channelId), fresh)) {
          throw new DomainError({ code: "update_failed", message: "The channel changed on YouTube while the translations were being prepared, so nothing was sent: apply again", details: { channelId } });
        }

        // 5. The default language, when missing (AC-CL-08): its own `brandingSettings` write (one part per request), every other
        // settable field sent back exactly as read, the title left out.
        let before = fresh;
        if (preview.defaultLanguage.change) {
          const channel = { ...pickSettableBrandingChannelFields(fresh.brandingChannel), defaultLanguage: ownLanguage };
          await deps.youtube.assertLiveWritesAuthorized();
          await deps.youtube.updateBrandingChannel(credentials, channelId, channel);
          writes++;
          defaultLanguageSet = ownLanguage;
          await deps.audit.record({ channelId, kind: "write", detail: { part: "brandingSettings", defaultLanguage: ownLanguage } });
          let after = await readLive(credentials, channelId);
          let problemText = brandingProblem(after, fresh, ownLanguage);
          for (let attempt = 1; attempt < attempts && problemText !== null; attempt++) {
            await deps.sleep(delayMs);
            after = await readLive(credentials, channelId);
            problemText = brandingProblem(after, fresh, ownLanguage);
          }
          if (problemText !== null) {
            const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: false, failure: "read_back_mismatch", detail: problemText, languages: [], defaultLanguageSet, writes, backupPath };
            await deps.audit.record({ channelId, kind: "verification", detail: { part: "brandingSettings", verified: false, problem: problemText } });
            await recordLastApply(channelId, result);
            return result;
          }
          before = after;
        }

        // 6. The safe merge (AC-CL-03/04): the set's languages added or replaced, every other kept, nothing deleted, the own language
        // never sent; then Live writes immediately before the one `localizations` write with the FULL map.
        if (languages.length > 0) {
          const merged = buildSafeLocalizationsPayload(
            { snippet: { title: before.snippet.title, description: before.snippet.description, defaultLanguage: ownLanguage }, localizations: before.localizations },
            Object.entries(stored).flatMap(([language, value]) => [
              { language, field: "title" as const, proposedValue: value.title },
              { language, field: "description" as const, proposedValue: value.description },
            ])
          ).localizations;
          await deps.youtube.assertLiveWritesAuthorized();
          await deps.youtube.updateLocalizations(credentials, channelId, merged);
          writes++;
          await deps.audit.record({ channelId, kind: "write", detail: { part: "localizations", languages, sent: Object.keys(merged) } });

          // 7. Read-back (AC-CL-07).
          let after = await readLive(credentials, channelId);
          let problemText = localizationsProblem(after, before, stored, ownLanguage);
          for (let attempt = 1; attempt < attempts && problemText !== null; attempt++) {
            await deps.sleep(delayMs);
            after = await readLive(credentials, channelId);
            problemText = localizationsProblem(after, before, stored, ownLanguage);
          }
          if (problemText !== null) {
            const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: false, failure: "read_back_mismatch", detail: problemText, languages, defaultLanguageSet, writes, backupPath };
            await deps.audit.record({ channelId, kind: "verification", detail: { part: "localizations", verified: false, problem: problemText } });
            await recordLastApply(channelId, result);
            return result;
          }
        }

        // 8. Audit and the last result.
        const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: true, languages, defaultLanguageSet, writes, backupPath };
        await deps.audit.record({ channelId, kind: "verification", detail: { verified: true, languages, defaultLanguageSet } });
        await recordLastApply(channelId, result);
        return result;
      } catch (error) {
        const code = isDomainError(error) ? error.code : "failed";
        const message = error instanceof Error ? error.message : "Unknown error";
        await deps.audit.record({ channelId, kind: "failed", detail: { code, message, writes, backupPath } }).catch(() => undefined);
        await recordLastApply(channelId, { at: deps.clock().toISOString(), ok: false, failure: "failed", detail: code, error: message, languages, defaultLanguageSet, writes, backupPath }).catch(() => undefined);
        throw error;
      }
    },
  };
  return service;
}

export type ChannelLocalizationsService = ReturnType<typeof createChannelLocalizationsService>;
