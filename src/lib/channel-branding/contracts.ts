import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { ChannelBannerMeta, ChannelBannerMimeType, ChannelBrandingDraft, ChannelBrandingField, ChannelBrandingFieldStatus } from "./draft";

export { DomainError, isDomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-223 (docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md, ADR 0050): the channel branding writer -- a channel's description,
// keywords and banner, saved as a local draft (the owner, the Factory Operator or the channel's own worker) and written to YouTube
// only by the owner's «Применить» in the Web UI, as a full read-merge-write of `brandingSettings` (+ `channelBanners.insert`).
// Never the name, avatar, country, default language, trailer or tracking id.
// ---------------------------------------------------------------------------

export type ChannelBrandingActor = "owner" | "factory" | "worker";

/** The last apply as stored and shown (codes for the agents; `error` is the owner's text). */
export type ChannelBrandingLastApply =
  | {
      at: string;
      ok: true;
      /** Fields written (new, changed or cleared); [] = nothing differed, nothing was written. */
      fields: ChannelBrandingField[];
      writes: number;
      backupPath: string | null;
      /** The banner this apply set (its draft hash and YouTube's URL), so a later preview can say "unchanged". */
      banner: { sha256: string; url: string } | null;
    }
  | {
      at: string;
      ok: false;
      /** written_unverified (review #2): channels.update succeeded, then the audit or the read-back failed -- written, not verified. */
      failure: "read_back_mismatch" | "banner_uploaded_not_set" | "written_unverified" | "failed";
      /** read_back_mismatch: what differed; banner_uploaded_not_set / written_unverified: the cause's code; failed: the error code. */
      detail: string;
      error?: string;
      fields: ChannelBrandingField[];
      writes: number;
      backupPath: string | null;
      banner: { sha256: string; url: string } | null;
    };

/** The channel on YouTube as the card and the agents see it (read now, 1 unit). */
export type ChannelBrandingLive = {
  title: string;
  avatarUrl: string | null;
  customUrl: string | null;
  description: string;
  keywords: string[];
  country: string | null;
  defaultLanguage: string | null;
  unsubscribedTrailer: string | null;
  bannerUrl: string | null;
};

export type ChannelBrandingView = {
  channelId: string;
  /** The stored draft (null = none, or unreadable: see `problem`). */
  draft: ChannelBrandingDraft | null;
  problem: string | null;
  updatedAt: string | null;
  updatedBy: ChannelBrandingActor | null;
  lastApply: ChannelBrandingLastApply | null;
};

/** `get`: the stored draft and last result, and the channel on YouTube now (null with the code when it cannot be read). */
export type ChannelBrandingGetView = ChannelBrandingView & { live: ChannelBrandingLive | null; liveUnavailable: string | null };

export type ChannelBrandingPreview = {
  fields: Array<{ field: ChannelBrandingField; status: ChannelBrandingFieldStatus }>;
  live: ChannelBrandingLive;
  /** The draft's banner against the channel's (the old one stays on YouTube until the update succeeds). */
  banner: { current: string | null; next: { width: number; height: number; bytes: number; mimeType: ChannelBannerMimeType } | null };
  quota: { readUnits: number; writes: number; writeUnits: number };
  /** The version of the stored draft this preview was computed from; «Применить» sends it back (refused if the draft changed since). */
  draftVersion: string;
};

export type ChannelBrandingStoreRow = {
  draftJson: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  lastApplyJson: string | null;
};

export type ChannelBrandingEventKind = "saved" | "backup" | "banner_upload" | "write" | "verification" | "failed";

/** What YouTube returns for the channel (the read gateway's `getChannelBrandingContext`). */
export type LiveChannelBranding = {
  title: string;
  avatarUrl: string | null;
  customUrl: string | null;
  brandingChannel: Record<string, unknown>;
  bannerExternalUrl: string | null;
  localizations: Record<string, { title: string; description: string }>;
};

/** A backup of the channel exactly as read before the first write (backup module, `kind: "channel_branding"`). */
export type ChannelBrandingBackupSnapshot = {
  kind: "channel_branding";
  title: string;
  brandingChannel: Record<string, unknown>;
  bannerExternalUrl: string | null;
  localizations: LiveChannelBranding["localizations"];
};

/** The banner given on save: new bytes (a Web upload), a workspace file (an agent), or the stored one kept. */
export type ChannelBannerInput = { kind: "bytes"; bytes: Buffer } | { kind: "workspace"; path: string } | { kind: "keep" };

export type ChannelBrandingSaveInput = { description?: unknown; keywords?: unknown; banner?: ChannelBannerInput };

/** The `brandingSettings` body sent (the write gateway's `ChannelBrandingSettingsBody`). */
export type ChannelBrandingBody = { channel: Record<string, string>; image?: { bannerExternalUrl: string } };

export type ChannelBrandingDependencies = {
  store: {
    get(channelId: string): Promise<ChannelBrandingStoreRow | null>;
    saveDraft(channelId: string, draft: { draftJson: string | null; updatedAt: Date; updatedBy: ChannelBrandingActor }): Promise<void>;
    saveLastApply(channelId: string, result: { lastApplyJson: string; lastApplyAt: Date }): Promise<void>;
  };
  /** The banner's bytes in the app data folder (`<app data>/channel-branding/<channelId>/banner.<ext>`). */
  banners: {
    write(channelId: string, banner: { bytes: Buffer; mimeType: ChannelBannerMimeType }): Promise<void>;
    /** null = no file. */
    read(channelId: string, mimeType: ChannelBannerMimeType): Promise<Buffer | null>;
    remove(channelId: string): Promise<void>;
  };
  /**
   * An agent's banner: a path relative to the channel workspace's `99 Data Exchange/Sent to YTM/` (the shared workspace-exchange
   * rules). Throws when the file cannot be used; `size` is checked before the bytes are read.
   */
  workspaceFile(channelId: string, relativePath: string): Promise<{ size: number; read(): Promise<Buffer> }>;
  /** A channel connected on this computer, with its connected account (null = not connected here). */
  channel(channelId: string): Promise<{ connectedUserId: string | null } | null>;
  auth: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  writeContext: {
    assertWriteChannel(args: { credentialRef: unknown; credentials: ResolvedCredentials; expectedChannelId: string }): Promise<unknown>;
  };
  youtube: {
    /** `channels.list part=snippet,brandingSettings,localizations` by id, through the read gateway; null = not returned. */
    read(credentials: ResolvedCredentials, channelId: string): Promise<LiveChannelBranding | null>;
    /** The shared Live-writes check (write gateway), called immediately before each write. */
    assertLiveWritesAuthorized(): Promise<void>;
    /** `channelBanners.insert` through the write gateway; YouTube's banner URL. */
    insertBanner(credentials: ResolvedCredentials, banner: { mimeType: ChannelBannerMimeType; bytes: Buffer }): Promise<{ url: string }>;
    /** `channels.update part=brandingSettings` with the full object, through the write gateway. */
    updateBranding(credentials: ResolvedCredentials, channelId: string, brandingSettings: ChannelBrandingBody): Promise<void>;
  };
  backup: {
    checkInfrastructureHealth(): Promise<{ healthy: boolean; error?: string }>;
    captureBackup(args: { channelId: string; operationId: string; subjectId: string; snapshot: ChannelBrandingBackupSnapshot }): Promise<{ path: string; capturedAt: string }>;
  };
  audit: { record(args: { channelId: string; kind: ChannelBrandingEventKind; detail: unknown }): Promise<void> };
  sha256(bytes: Buffer | string): string;
  sleep(ms: number): Promise<void>;
  clock(): Date;
  newId(): string;
  /** Reads (the first included) while the channel does not yet show what was written, and the pause between them. */
  readBack?: { attempts: number; delayMs: number };
};

export type { ChannelBannerMeta };
