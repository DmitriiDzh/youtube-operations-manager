import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { DomainError } from "@/lib/shared-domain";
import { sameLanguage } from "@/lib/shared-language-baseline";
import { buildSafeLocalizationsPayload, checkDefaultLanguage, localeKeyFor } from "@/lib/shared-localization-merge";
// BL-225 stage 3 (ADR 0051, AGENTS.md §M): moved from `live-localizations` unchanged so the upload of a planned release package
// (publishing) can write its translations by the same rules without one feature module reaching into another. The live-localizations
// module re-exports it under its own names; each caller passes its `source` for the audit.
import type { ExpectedSnippet, FreshLiveVideo, LiveLocalizationEntry, LiveLocalizationsApplyInput, LiveLocalizationsApplyResult, LiveLocalizationsWriterDependencies } from "./contracts";

/**
 * A localization written to a live broadcast's video has never been read back (unverified, like the BL-205 spike): up to 6 reads,
 * 10 s apart, before the step is reported as not verified. The same bound waits for the fields step's values to show.
 */
export const LIVE_LOCALIZATIONS_READ_BACK = { attempts: 6, delayMs: 10_000 };

const sortedJson = (list: unknown) => (Array.isArray(list) ? JSON.stringify(list.map((item) => JSON.stringify(item)).sort()) : JSON.stringify(list ?? null));

type Snippet = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
/** Two language values alike in any letter case; none and none alike too (`sameLanguage` says no for two absent values). */
const sameValue = (a: unknown, b: unknown) => (text(a) === null && text(b) === null) || sameLanguage(text(a), text(b));

/** The snippet fields the update sends back besides the text, each with what a difference is called. */
const SNIPPET_FIELDS = [
  { field: "tags", label: "tags changed", same: (a: unknown, b: unknown) => sortedJson(a ?? []) === sortedJson(b ?? []) },
  { field: "categoryId", label: "category changed", same: (a: unknown, b: unknown) => (a ?? null) === (b ?? null) },
  { field: "defaultLanguage", label: "default language changed", same: sameValue },
  { field: "defaultAudioLanguage", label: "audio language changed", same: sameValue },
] as const;

/** What differs between two reads' tags, category and languages (tags in any order: a live broadcast reads them back sorted). */
function snippetDifferences(video: FreshLiveVideo, reference: FreshLiveVideo): string[] {
  const a = video.snippet as Snippet;
  const b = reference.snippet as Snippet;
  return SNIPPET_FIELDS.filter(({ field, same }) => !same(a[field], b[field])).map(({ label }) => label);
}

/** Which of the fields step's values the snippet does not show (only the fields it sent). */
function expectedProblems(video: FreshLiveVideo, expected: ExpectedSnippet): string[] {
  const snippet = video.snippet as Snippet;
  return SNIPPET_FIELDS.filter(({ field, same }) => field in expected && !same(snippet[field], (expected as Snippet)[field])).map(({ label }) => label);
}

const localizationsJson = (localizations: Record<string, LiveLocalizationEntry>) =>
  JSON.stringify(Object.keys(localizations).sort().map((key) => [key, localizations[key].title, localizations[key].description]));

/** Whether a second read differs from the one the payload was built from in anything the update sends back. */
function changedBetweenReads(second: FreshLiveVideo, first: FreshLiveVideo): boolean {
  return (
    second.snippet.title !== first.snippet.title ||
    second.snippet.description !== first.snippet.description ||
    (second.snippet.defaultLanguage ?? null) !== (first.snippet.defaultLanguage ?? null) ||
    (text((second.snippet as Snippet).defaultAudioLanguage) ?? null) !== (text((first.snippet as Snippet).defaultAudioLanguage) ?? null) ||
    snippetDifferences(second, first).length > 0 ||
    localizationsJson(second.localizations) !== localizationsJson(first.localizations)
  );
}

/**
 * What the read-back shows wrong, or null when it holds: every written language exactly as sent, every other language the video
 * had kept as it was (its own-language mirror aside: the merge never sends it), the snippet text unchanged, and the tags,
 * category and languages still as sent and as the fields step wrote them.
 */
function readBackProblem(after: FreshLiveVideo, before: FreshLiveVideo, set: Record<string, LiveLocalizationEntry>, expected: ExpectedSnippet): string | null {
  const problems: string[] = [];
  if (after.snippet.title !== before.snippet.title || after.snippet.description !== before.snippet.description) problems.push("the base title or description changed");
  const missing: string[] = [];
  const differs: string[] = [];
  for (const [language, value] of Object.entries(set)) {
    const key = localeKeyFor(after.localizations, language);
    if (key === null) missing.push(language);
    else if (after.localizations[key].title !== value.title || after.localizations[key].description !== value.description) differs.push(language);
  }
  const lost: string[] = [];
  const otherChanged: string[] = [];
  const languages = Object.keys(set);
  for (const [language, value] of Object.entries(before.localizations)) {
    if (sameLanguage(language, before.snippet.defaultLanguage) || languages.some((written) => sameLanguage(written, language))) continue;
    const key = localeKeyFor(after.localizations, language);
    if (key === null) lost.push(language);
    else if (after.localizations[key].title !== value.title || after.localizations[key].description !== value.description) otherChanged.push(language);
  }
  if (missing.length > 0) problems.push(`language missing: ${missing.join(", ")}`);
  if (differs.length > 0) problems.push(`text differs: ${differs.join(", ")}`);
  if (lost.length > 0) problems.push(`language lost: ${lost.join(", ")}`);
  if (otherChanged.length > 0) problems.push(`other language changed: ${otherChanged.join(", ")}`);
  for (const label of new Set([...snippetDifferences(after, before), ...expectedProblems(after, expected)])) problems.push(label);
  return problems.length > 0 ? problems.join("; ") : null;
}

export function createLiveLocalizationsWriter(deps: LiveLocalizationsWriterDependencies) {
  const { attempts, delayMs } = deps.readBack ?? LIVE_LOCALIZATIONS_READ_BACK;
  // BL-225 stage 3: which writer the audit names (`live_localizations` for BL-207, `upload_localizations` for BL-225).
  const source = deps.source ?? "live_localizations";

  async function read(credentials: Parameters<LiveLocalizationsWriterDependencies["youtube"]["readFresh"]>[0], videoId: string): Promise<FreshLiveVideo> {
    const video = await deps.youtube.readFresh(credentials, videoId);
    if (!video) throw new DomainError({ code: "not_found", message: "YouTube does not return the broadcast's video", details: { videoId } });
    return video;
  }

  return {
    /**
     * The stream's stored set onto one broadcast's video (AGENTS.md §G): identity, a fresh read, its default language, the set
     * never holding it, a backup, the broadcast still current and the video unchanged right before the write, the safe merge,
     * Live writes immediately before the one update, a read-back, the audit.
     */
    async apply(input: LiveLocalizationsApplyInput): Promise<LiveLocalizationsApplyResult> {
      const { channelId, videoId, localizations } = input;
      const languages = Object.keys(localizations);
      if (languages.length === 0) return { verified: true };

      // 1. Identity: the account is the channel's (fails closed).
      const credentials = await deps.auth.resolve({ credentialRef: input.credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
      await deps.writeContext.assertWriteChannel({ credentialRef: input.credentialRef, credentials, expectedChannelId: channelId });

      // 2. A fresh read. The snippet part is sent whole, so it must already show what the fields step just wrote -- an older
      // replica's read echoed back would undo it (tags read back tens of seconds late on a fresh broadcast, spike C).
      const expected = input.expected ?? {};
      let fresh = await read(credentials, videoId);
      for (let attempt = 1; attempt < attempts && expectedProblems(fresh, expected).length > 0; attempt++) {
        await deps.sleep(delayMs);
        fresh = await read(credentials, videoId);
      }
      if (expectedProblems(fresh, expected).length > 0) {
        throw new DomainError({ code: "update_failed", message: "The video's fields do not read back as just written yet, so the translations were not sent (they would undo them)", details: { videoId } });
      }

      // 3. A video without a default language is never written (and never given one here).
      const defaultLanguage = checkDefaultLanguage(fresh.snippet);
      if (!defaultLanguage.ok) throw new DomainError({ code: "validation_failed", message: defaultLanguage.reason, details: { videoId } });

      // 4. The video's own language is its snippet text, never a translation (PROJECT_SPEC §14): fail closed.
      const own = languages.find((language) => sameLanguage(language, fresh.snippet.defaultLanguage));
      if (own) {
        throw new DomainError({
          code: "validation_failed",
          message: `The translations hold "${own}", the video's own language (${fresh.snippet.defaultLanguage}): nothing was written. Remove it from the stream's translations.`,
          details: { videoId, language: own },
        });
      }

      // 5. Backup of what the write may change.
      const health = await deps.backup.checkInfrastructureHealth();
      if (!health.healthy) throw new DomainError({ code: "backup_infrastructure_unavailable", message: health.error ?? "Backup storage is unreachable" });
      const backup = await deps.backup.captureBackup({
        channelId,
        operationId: deps.newId(),
        videoId,
        snapshot: { kind: "localization", defaultLanguage: fresh.snippet.defaultLanguage, existingLocalizations: fresh.localizations, snippetTitle: fresh.snippet.title, snippetDescription: fresh.snippet.description },
      });
      await deps.audit.record({ channelId, videoId, eventType: "BACKUP", detail: { source, backupPath: backup.path } });

      // 6. Right before the write: the broadcast is still the stream's running one (a Stop or a segment switch may have landed
      // meanwhile), and the video still reads as the read the payload is built from -- an Edit made since would be undone by the
      // snippet sent whole, so a changed video is refused (1 more read). The broadcast lock is not taken here: Edit holds it.
      if (input.isCurrent) {
        const state = await input.isCurrent();
        if (state !== "current") return { sent: false, reason: state };
      }
      const recheck = await read(credentials, videoId);
      if (changedBetweenReads(recheck, fresh)) {
        throw new DomainError({ code: "update_failed", message: "The video changed while the translations were being prepared, so nothing was sent: apply again", details: { videoId } });
      }
      // The same values; the latest read is the one sent back.
      fresh = recheck;

      // 7. The safe merge: the set's languages overwritten, every other kept, nothing deleted. The audio language just read is sent
      // back as it is, `zxx` included (the fields step writes it, schemas.ts allows it) -- `videos.update` resets a snippet field
      // left out (RISK-102). None read: none sent.
      const audio = typeof fresh.snippet.defaultAudioLanguage === "string" && fresh.snippet.defaultAudioLanguage.length > 0 ? fresh.snippet.defaultAudioLanguage : null;
      const payload = buildSafeLocalizationsPayload(
        fresh,
        languages.flatMap((language) => [
          { language, field: "title" as const, proposedValue: localizations[language].title },
          { language, field: "description" as const, proposedValue: localizations[language].description },
        ]),
        { defaultAudioLanguage: audio }
      );

      // 8. Live writes, immediately before the one write.
      await deps.youtube.assertLiveWritesAuthorized();
      await deps.youtube.update(credentials, videoId, payload);
      await deps.audit.record({ channelId, videoId, eventType: "RESULT", detail: { source, languages } });

      // 9. Read-back: every written language exactly, every other kept, the snippet text and fields unchanged.
      const before = fresh;
      let after = await read(credentials, videoId);
      let problem = readBackProblem(after, before, localizations, expected);
      for (let attempt = 1; attempt < attempts && problem !== null; attempt++) {
        await deps.sleep(delayMs);
        after = await read(credentials, videoId);
        problem = readBackProblem(after, before, localizations, expected);
      }

      // 10. Audit.
      await deps.audit.record({ channelId, videoId, eventType: "VERIFICATION", detail: problem === null ? { source, verified: true } : { source, verified: false, problem } });
      return problem === null ? { verified: true } : { verified: false, detail: problem };
    },
  };
}

export type LiveLocalizationsWriter = ReturnType<typeof createLiveLocalizationsWriter>;
