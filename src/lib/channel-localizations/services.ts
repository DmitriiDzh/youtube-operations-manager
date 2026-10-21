import { createHash } from "node:crypto";
import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { sameLanguage } from "@/lib/shared-language-baseline";
import { buildSafeLocalizationsPayload, localeKeyFor } from "@/lib/shared-localization-merge";
import { DomainError, isDomainError, type ChannelLocalizationsActor, type ChannelLocalizationsDependencies, type ChannelLocalizationsLastApply, type ChannelLocalizationsPreviewView, type ChannelLocalizationsView } from "./contracts";
import { channelDefaultLanguage, ownLanguageEntry, previewChannelLocalizations, readStoredChannelLocalizations, validateChannelLocalizations, type ChannelLocalizationSet, type LiveChannelLocalizations } from "./set";

/** Up to 4 reads, 5 s apart, while the channel does not yet show what was written. */
export const CHANNEL_LOCALIZATIONS_READ_BACK = { attempts: 4, delayMs: 5_000 };

const PROBLEM_ERRORS = {
  empty_set: { code: "validation_failed", message: "No translations are saved for this channel: nothing to apply" },
  default_language_not_set: {
    code: "channel_default_language_not_set",
    message: "The channel has no default language on YouTube (brandingSettings.channel.defaultLanguage): set it once in YouTube Studio (Settings → Channel → Basic info → Language), then apply again. Nothing was written",
  },
  default_language_mismatch: { code: "default_language_mismatch", message: "The channel's two default-language fields on YouTube disagree: nothing was written" },
  own_language_in_live: {
    code: "own_language_in_live",
    message: "YouTube lists a translation in the channel's own language that differs from the channel's name or description: fix it in YouTube Studio first. Nothing was written",
  },
  own_language_in_set: { code: "validation_failed", message: "The translations hold the channel's own language (its text is the base title and description): remove it" },
} as const;

/** The version of a stored set the owner previewed: the SHA-256 of the stored column ("" = none stored). */
export function channelLocalizationsSetVersion(localizationsJson: string | null | undefined): string {
  return createHash("sha256").update(localizationsJson ?? "").digest("hex");
}

/** JSON with object keys sorted, so two reads of the same object compare equal whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether a second read differs from the first in anything the write sends back or must keep. */
function changedBetweenReads(second: LiveChannelLocalizations, first: LiveChannelLocalizations): boolean {
  return (
    second.snippet.title !== first.snippet.title ||
    second.snippet.description !== first.snippet.description ||
    (second.snippet.defaultLanguage ?? null) !== (first.snippet.defaultLanguage ?? null) ||
    stableJson(second.brandingChannel) !== stableJson(first.brandingChannel) ||
    stableJson(second.localizations) !== stableJson(first.localizations)
  );
}

/**
 * After the `localizations` write: every written language exactly as sent, every other language as it was (the own-language entry
 * included: it is sent back unchanged), the base text and the branding settings (the default language among them) unchanged.
 */
function localizationsProblem(after: LiveChannelLocalizations, before: LiveChannelLocalizations, set: ChannelLocalizationSet): string | null {
  const problems: string[] = [];
  if (after.snippet.title !== before.snippet.title || after.snippet.description !== before.snippet.description) problems.push("the base title or description changed");
  if (stableJson(after.brandingChannel) !== stableJson(before.brandingChannel)) problems.push("branding settings changed");
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
    if (Object.keys(set).some((written) => sameLanguage(written, language))) continue;
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
      return { defaultLanguage: channelDefaultLanguage(live).language, localizations: live.localizations };
    },

    /**
     * What Apply would do now (1-unit read; nothing is written), with the version of the stored set it was computed from -- the apply
     * must be sent that version (review #2: the owner applies what they previewed).
     */
    async preview(channelId: string): Promise<ChannelLocalizationsPreviewView> {
      const { set, row } = await storedSet(channelId);
      const live = await readWithChannelAccount(channelId);
      return { ...previewChannelLocalizations(set, live), live: live.localizations, setVersion: channelLocalizationsSetVersion(row?.localizationsJson) };
    },

    /**
     * The owner's «Применить» (AGENTS.md §G): the stored set still the one previewed (`setVersion`), identity, a fresh read, the
     * preview's problems refused, a backup, the channel unchanged right before the write, the safe merge, Live writes right before
     * the one write, a read-back, the audit and the last result. Never writes anything but `localizations` (owner msg 3350).
     */
    async apply(channelId: string, credentialRef: unknown, setVersion: unknown): Promise<ChannelLocalizationsLastApply> {
      let backupPath: string | null = null;
      let writes = 0;
      let languages: string[] = [];
      await connectedChannel(channelId);
      try {
        const { set, problem, row } = await storedSet(channelId);
        // 0. The set the owner previewed (review #2): the Operator (or another tab) may have saved another one since.
        if (typeof setVersion !== "string" || setVersion.length === 0) {
          throw new DomainError({ code: "validation_failed", message: "The version of the previewed translations is missing: check against YouTube first", details: { channelId } });
        }
        if (setVersion !== channelLocalizationsSetVersion(row?.localizationsJson)) {
          throw new DomainError({ code: "localizations_changed", message: "The saved translations changed since they were checked: check against YouTube again. Nothing was written", details: { channelId } });
        }
        if (problem) throw new DomainError({ code: "validation_failed", message: `The saved translations cannot be applied: ${problem}`, details: { channelId } });

        // 1. Identity: the account is the channel's (fails closed, AC-CL-05).
        const credentials = await deps.auth.resolve({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
        await deps.writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });

        // 2. A fresh read and what it means (AC-CL-09: no default language -> refused before any write; owner msg 3350).
        const fresh = await readLive(credentials, channelId);
        const preview = previewChannelLocalizations(set, fresh);
        const first = preview.problems[0];
        if (first) throw new DomainError({ ...PROBLEM_ERRORS[first], details: { channelId, problems: preview.problems } });
        const stored = set as ChannelLocalizationSet;
        const ownLanguage = preview.ownLanguage as string;
        languages = preview.languages.filter((l) => l.status !== "unchanged").map((l) => l.language);
        if (preview.quota.writes === 0) {
          const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: true, languages: [], writes: 0, backupPath: null };
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

        // 4. Right before the write: the channel still reads as the read the write is built from (an edit made in Studio meanwhile
        // would be undone by the part sent whole).
        if (changedBetweenReads(await readLive(credentials, channelId), fresh)) {
          throw new DomainError({ code: "update_failed", message: "The channel changed on YouTube while the translations were being prepared, so nothing was sent: apply again", details: { channelId } });
        }

        // 5. The safe merge (AC-CL-03/04): the set's languages added or replaced, every other kept, nothing deleted. The merge leaves
        // out an own-language entry; here it equals the base text (else refused above, review #1), so it is sent back unchanged.
        const merged = buildSafeLocalizationsPayload(
          { snippet: { title: fresh.snippet.title, description: fresh.snippet.description, defaultLanguage: ownLanguage }, localizations: fresh.localizations },
          Object.entries(stored).flatMap(([language, value]) => [
            { language, field: "title" as const, proposedValue: value.title },
            { language, field: "description" as const, proposedValue: value.description },
          ])
        ).localizations;
        const own = ownLanguageEntry(fresh, ownLanguage);
        if (own) merged[own.key] = { ...fresh.localizations[own.key] };

        // 6. Live writes immediately before the one `localizations` write with the FULL map.
        await deps.youtube.assertLiveWritesAuthorized();
        await deps.youtube.updateLocalizations(credentials, channelId, merged);
        writes++;
        await deps.audit.record({ channelId, kind: "write", detail: { part: "localizations", languages, sent: Object.keys(merged) } });

        // 7. Read-back (AC-CL-07).
        let after = await readLive(credentials, channelId);
        let problemText = localizationsProblem(after, fresh, stored);
        for (let attempt = 1; attempt < attempts && problemText !== null; attempt++) {
          await deps.sleep(delayMs);
          after = await readLive(credentials, channelId);
          problemText = localizationsProblem(after, fresh, stored);
        }
        if (problemText !== null) {
          const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: false, failure: "read_back_mismatch", detail: problemText, languages, writes, backupPath };
          await deps.audit.record({ channelId, kind: "verification", detail: { verified: false, problem: problemText } });
          await recordLastApply(channelId, result);
          return result;
        }

        // 8. Audit and the last result.
        const result: ChannelLocalizationsLastApply = { at: deps.clock().toISOString(), ok: true, languages, writes, backupPath };
        await deps.audit.record({ channelId, kind: "verification", detail: { verified: true, languages } });
        await recordLastApply(channelId, result);
        return result;
      } catch (error) {
        const code = isDomainError(error) ? error.code : "failed";
        const message = error instanceof Error ? error.message : "Unknown error";
        await deps.audit.record({ channelId, kind: "failed", detail: { code, message, writes, backupPath } }).catch(() => undefined);
        await recordLastApply(channelId, { at: deps.clock().toISOString(), ok: false, failure: "failed", detail: code, error: message, languages, writes, backupPath }).catch(() => undefined);
        throw error;
      }
    },
  };
  return service;
}

export type ChannelLocalizationsService = ReturnType<typeof createChannelLocalizationsService>;
