import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { ChannelLocalizationSet, ChannelLocalizationsPreview, LiveChannelLocalizations } from "./set";

export { DomainError, isDomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-210 (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md, ADR 0047): the third authorized writer of per-language title/description
// (AGENTS.md §F) -- a channel's OWN translations (`channels.update part=localizations`), applied only by the owner's «Применить»
// in the Web UI. It never deletes a language, never touches the base title/description, never writes the channel's own language
// as a translation; when the channel has no default language it sets the baseline as `brandingSettings.channel.defaultLanguage`
// first (a separate write: one part per request), sending every other settable branding field back exactly as read.
// ---------------------------------------------------------------------------

export type ChannelLocalizationsActor = "owner" | "factory";

/** The last apply as stored and shown (codes for the Operator; `error` is the owner's text). */
export type ChannelLocalizationsLastApply =
  | {
      at: string;
      ok: true;
      /** Languages written (new or changed); [] = nothing differed, nothing was written. */
      languages: string[];
      /** The default language set by this apply (null = not changed). */
      defaultLanguageSet: string | null;
      writes: number;
      backupPath: string | null;
    }
  | {
      at: string;
      ok: false;
      failure: "read_back_mismatch" | "failed";
      /** read_back_mismatch: what differed; failed: the error code. */
      detail: string;
      error?: string;
      languages: string[];
      defaultLanguageSet: string | null;
      writes: number;
      backupPath: string | null;
    };

export type ChannelLocalizationsView = {
  channelId: string;
  /** The stored set (null = none, or unreadable: see `problem`). */
  localizations: ChannelLocalizationSet | null;
  problem: string | null;
  /** The channel's baseline title/description language (null = none set). */
  baselineLanguage: string | null;
  updatedAt: string | null;
  updatedBy: ChannelLocalizationsActor | null;
  lastApply: ChannelLocalizationsLastApply | null;
};

export type ChannelLocalizationsPreviewView = ChannelLocalizationsPreview & {
  /** The channel's translations on YouTube now (read for this preview, 1 unit). */
  live: Record<string, { title: string; description: string }>;
};

export type ChannelLocalizationsStoreRow = {
  localizationsJson: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  lastApplyJson: string | null;
};

export type ChannelLocalizationEventKind = "saved" | "backup" | "write" | "verification" | "failed";

/** A backup of the channel exactly as read before the first write (backup module, `kind: "channel_localizations"`). */
export type ChannelBackupSnapshot = { kind: "channel_localizations"; snippet: LiveChannelLocalizations["snippet"]; brandingChannel: Record<string, unknown>; localizations: LiveChannelLocalizations["localizations"] };

export type ChannelLocalizationsDependencies = {
  store: {
    get(channelId: string): Promise<ChannelLocalizationsStoreRow | null>;
    saveSet(channelId: string, set: { localizationsJson: string | null; updatedAt: Date; updatedBy: ChannelLocalizationsActor }): Promise<void>;
    saveLastApply(channelId: string, result: { lastApplyJson: string; lastApplyAt: Date }): Promise<void>;
  };
  /** A channel connected on this computer, with its connected account (null = not connected here). */
  channel(channelId: string): Promise<{ connectedUserId: string | null } | null>;
  /** The channel's baseline title/description language (null = none set). */
  baselineLanguage(channelId: string): Promise<string | null>;
  auth: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  writeContext: {
    assertWriteChannel(args: { credentialRef: unknown; credentials: ResolvedCredentials; expectedChannelId: string }): Promise<unknown>;
  };
  youtube: {
    /** `channels.list part=snippet,brandingSettings,localizations` by id, through the read gateway; null = not returned. */
    read(credentials: ResolvedCredentials, channelId: string): Promise<LiveChannelLocalizations | null>;
    /** The shared Live-writes check (write gateway), called immediately before each write. */
    assertLiveWritesAuthorized(): Promise<void>;
    /** `channels.update part=brandingSettings` (only `brandingSettings.channel`), through the write gateway. */
    updateBrandingChannel(credentials: ResolvedCredentials, channelId: string, channel: Record<string, unknown>): Promise<void>;
    /** `channels.update part=localizations` with the full map, through the write gateway. */
    updateLocalizations(credentials: ResolvedCredentials, channelId: string, localizations: Record<string, { title: string; description: string }>): Promise<void>;
  };
  backup: {
    checkInfrastructureHealth(): Promise<{ healthy: boolean; error?: string }>;
    captureBackup(args: { channelId: string; operationId: string; subjectId: string; snapshot: ChannelBackupSnapshot }): Promise<{ path: string; capturedAt: string }>;
  };
  audit: { record(args: { channelId: string; kind: ChannelLocalizationEventKind; detail: unknown }): Promise<void> };
  sleep(ms: number): Promise<void>;
  clock(): Date;
  newId(): string;
  /** Reads (the first included) while the channel does not yet show what was written, and the pause between them. */
  readBack?: { attempts: number; delayMs: number };
};
