import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { DomainError } from "@/lib/shared-domain";
import { sameLanguage } from "@/lib/shared-language-baseline";
import { buildSafeLocalizationsPayload, checkDefaultLanguage, localeKeyFor } from "@/lib/shared-localization-merge";
import type { ExpectedSnippet, FreshLiveVideo, LiveLocalizationEntry, LiveLocalizationsApplyInput, LiveLocalizationsApplyResult, LiveLocalizationsWriterDependencies } from "./contracts";

/**
 * A localization written to a live broadcast's video has never been read back (unverified, like the BL-205 spike): up to 6 reads,
 * 10 s apart, before the step is reported as not verified. The same bound waits for the fields step's values to show.
 */
export const LIVE_LOCALIZATIONS_READ_BACK = { attempts: 6, delayMs: 10_000 };

const sortedJson = (list: unknown) => (Array.isArray(list) ? JSON.stringify(list.map((item) => JSON.stringify(item)).sort()) : JSON.stringify(list ?? null));

/** Whether the fresh snippet already shows the fields step's values (tags in any order: a live broadcast reads them back sorted). */
function expectedHolds(video: FreshLiveVideo, expected: ExpectedSnippet): boolean {
  const snippet = video.snippet as Record<string, unknown>;
  if ("tags" in expected && sortedJson(snippet.tags ?? []) !== sortedJson(expected.tags)) return false;
  if ("categoryId" in expected && (snippet.categoryId ?? null) !== expected.categoryId) return false;
  for (const field of ["defaultLanguage", "defaultAudioLanguage"] as const) {
    if (field in expected && !sameLanguage(snippet[field] as string | null | undefined, expected[field] as string | null | undefined)) return false;
  }
  return true;
}

/** What the read-back shows wrong, or null when every written language and the snippet text are exactly as sent. */
function readBackProblem(after: FreshLiveVideo, before: FreshLiveVideo, set: Record<string, LiveLocalizationEntry>): string | null {
  const problems: string[] = [];
  if (after.snippet.title !== before.snippet.title || after.snippet.description !== before.snippet.description) problems.push("the base title or description changed");
  const missing: string[] = [];
  const differs: string[] = [];
  for (const [language, value] of Object.entries(set)) {
    const key = localeKeyFor(after.localizations, language);
    if (key === null) missing.push(language);
    else if (after.localizations[key].title !== value.title || after.localizations[key].description !== value.description) differs.push(language);
  }
  if (missing.length > 0) problems.push(`language missing: ${missing.join(", ")}`);
  if (differs.length > 0) problems.push(`text differs: ${differs.join(", ")}`);
  return problems.length > 0 ? problems.join("; ") : null;
}

export function createLiveLocalizationsWriter(deps: LiveLocalizationsWriterDependencies) {
  const { attempts, delayMs } = deps.readBack ?? LIVE_LOCALIZATIONS_READ_BACK;

  async function read(credentials: Parameters<LiveLocalizationsWriterDependencies["youtube"]["readFresh"]>[0], videoId: string): Promise<FreshLiveVideo> {
    const video = await deps.youtube.readFresh(credentials, videoId);
    if (!video) throw new DomainError({ code: "not_found", message: "YouTube does not return the broadcast's video", details: { videoId } });
    return video;
  }

  return {
    /**
     * The stream's stored set onto one broadcast's video (AGENTS.md §G): identity, a fresh read, its default language, the set
     * never holding it, a backup, the safe merge, Live writes immediately before the one update, a read-back, the audit.
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
      for (let attempt = 1; attempt < attempts && !expectedHolds(fresh, expected); attempt++) {
        await deps.sleep(delayMs);
        fresh = await read(credentials, videoId);
      }
      if (!expectedHolds(fresh, expected)) {
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
      await deps.audit.record({ channelId, videoId, eventType: "BACKUP", detail: { source: "live_localizations", backupPath: backup.path } });

      // 6. The safe merge: the set's languages overwritten, every other kept, nothing deleted. The audio language just read is sent
      // back -- `videos.update` resets a snippet field left out (RISK-102); `zxx` is refused when echoed and is left out.
      const audio = typeof fresh.snippet.defaultAudioLanguage === "string" ? fresh.snippet.defaultAudioLanguage : null;
      const payload = buildSafeLocalizationsPayload(
        fresh,
        languages.flatMap((language) => [
          { language, field: "title" as const, proposedValue: localizations[language].title },
          { language, field: "description" as const, proposedValue: localizations[language].description },
        ]),
        { defaultAudioLanguage: audio && audio.toLowerCase() !== "zxx" ? audio : null }
      );

      // 7. Live writes, immediately before the one write.
      await deps.youtube.assertLiveWritesAuthorized();
      await deps.youtube.update(credentials, videoId, payload);
      await deps.audit.record({ channelId, videoId, eventType: "RESULT", detail: { source: "live_localizations", languages } });

      // 8. Read-back: every written language exactly, the snippet text unchanged.
      let after = await read(credentials, videoId);
      let problem = readBackProblem(after, fresh, localizations);
      for (let attempt = 1; attempt < attempts && problem !== null; attempt++) {
        await deps.sleep(delayMs);
        after = await read(credentials, videoId);
        problem = readBackProblem(after, fresh, localizations);
      }

      // 9. Audit.
      await deps.audit.record({ channelId, videoId, eventType: "VERIFICATION", detail: problem === null ? { source: "live_localizations", verified: true } : { source: "live_localizations", verified: false, problem } });
      return problem === null ? { verified: true } : { verified: false, detail: problem };
    },
  };
}

export type LiveLocalizationsWriter = ReturnType<typeof createLiveLocalizationsWriter>;
