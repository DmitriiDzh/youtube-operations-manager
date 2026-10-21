import type { FreshVideoContext, SafeLocalizationsPayload } from "@/lib/shared-localization-merge";
import type { ResolvedCredentials } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-207 stage 3 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2, ADR 0045): the second authorized writer of per-language
// title/description, besides Batches -- limited to a live broadcast's video and to the stream's stored set. It never deletes a
// language, never touches the snippet text, and keeps every language the set does not name (PROJECT_SPEC §21).
// ---------------------------------------------------------------------------

export type LiveLocalizationEntry = { title: string; description: string };

/** The fresh `videos.list snippet,localizations` read, with the snippet's other fields (tags, category, audio language...). */
export type FreshLiveVideo = FreshVideoContext & {
  snippet: FreshVideoContext["snippet"] & { defaultAudioLanguage?: string | null; tags?: string[] | null; categoryId?: string | null };
};

/** The fields step's snippet values (the same run wrote them seconds earlier): the fresh read must already show them. */
export type ExpectedSnippet = { tags?: unknown; categoryId?: unknown; defaultLanguage?: unknown; defaultAudioLanguage?: unknown };

export type LiveLocalizationsApplyInput = {
  credentialRef: unknown;
  channelId: string;
  videoId: string;
  localizations: Record<string, LiveLocalizationEntry>;
  expected?: ExpectedSnippet;
};

/** `verified: false` = YouTube took the update but reads back something else (`detail` says what). Failures before it throw. */
export type LiveLocalizationsApplyResult = { verified: true } | { verified: false; detail: string };

export type LiveLocalizationsWriterDependencies = {
  auth: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  writeContext: {
    assertWriteChannel(args: { credentialRef: unknown; credentials: ResolvedCredentials; expectedChannelId: string }): Promise<{ expectedChannelId: string }>;
  };
  youtube: {
    /** `videos.list snippet,localizations` through the read gateway; null when YouTube does not return the video. */
    readFresh(credentials: ResolvedCredentials, videoId: string): Promise<FreshLiveVideo | null>;
    /** The shared Live-writes check (write gateway), called immediately before `update`. */
    assertLiveWritesAuthorized(): Promise<void>;
    /** `videos.update part=snippet,localizations` through the write gateway. */
    update(credentials: ResolvedCredentials, videoId: string, payload: SafeLocalizationsPayload): Promise<void>;
  };
  backup: {
    checkInfrastructureHealth(): Promise<{ healthy: boolean; error?: string }>;
    captureBackup(args: {
      channelId: string;
      operationId: string;
      videoId: string;
      snapshot: { kind: "localization"; defaultLanguage: string | null; existingLocalizations: Record<string, LiveLocalizationEntry>; snippetTitle: string; snippetDescription: string };
    }): Promise<{ path: string; capturedAt: string }>;
  };
  audit: { record(args: { channelId: string; videoId: string; eventType: "BACKUP" | "RESULT" | "VERIFICATION"; detail: unknown }): Promise<void> };
  sleep(ms: number): Promise<void>;
  newId(): string;
  /** Reads (the first included) while the video does not yet show what was written; the pause between them. */
  readBack?: { attempts: number; delayMs: number };
};
