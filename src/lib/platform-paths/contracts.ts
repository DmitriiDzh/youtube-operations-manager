// Pure types for platform-aware app-data path resolution. No I/O, no process.* reads here --
// every input is injected (docs/decisions/0002-additive-schema-versioning.md's companion task,
// "Pre-Release Cross-Platform Persistence" plan, decision 4: never read process.platform ad hoc
// at call sites).

export const APP_DIRECTORY_NAME = "YouTubeOperationsManager";

export type SupportedPlatform = "win32" | "darwin" | "linux";

export type ResolveAppPathsInput = {
  /** Node's process.platform value, injected by the caller. */
  platform: NodeJS.Platform;
  /** A snapshot of relevant environment variables (APPDATA, XDG_DATA_HOME, ...). */
  env: Record<string, string | undefined>;
  /** The current user's home directory (os.homedir()), injected by the caller. */
  homedir: string;
};

export type AppPaths = {
  /** Root app-data directory for this device (e.g. %APPDATA%\YouTubeOperationsManager). */
  appDataDir: string;
  /** Path to the primary SQLite database file. */
  dbPath: string;
  /** Directory holding per-write-batch immutable backups (src/lib/backup/). */
  backupsDir: string;
  /** Directory holding pre-migration/pre-import full-database backups. */
  migrationBackupsDir: string;
  /** Directory holding published + staged snapshot directories (src/lib/snapshot/). */
  snapshotsDir: string;
  /** Directory holding per-channel Automerge draft documents (src/lib/change-drafts/). */
  changeDraftsDir: string;
  /**
   * Local-only fallback exchange directory for change-drafts sync (src/lib/change-drafts-sync/)
   * when no Syncthing-shared folder is configured yet -- mirrors `resolveSnapshotsDir`'s own
   * `config.syncthingRootPath ?? appDataPaths.snapshotsDir` fallback pattern
   * (src/app/api/device-handoff/shared.ts), kept as its own directory rather than reusing
   * `snapshotsDir` so per-device `.automerge` exchange files never mix with snapshot-id folders.
   */
  changeDraftsSyncFallbackDir: string;
  /**
   * Directory holding pre-discard backups of a channel's local Automerge document
   * (`src/lib/change-drafts/`), captured before an operator-triggered "discard my local copy,
   * adopt a peer's version instead" divergent-lineage resolution (`docs/TECHNICAL_DEBT.md`
   * RISK-46). Deliberately its OWN directory, not `backupsDir` above -- that one's `write()`
   * assumes a per-video snapshot shape (`BackupSnapshot`'s `"localization"`/`"video_fields"`
   * variants); a whole-channel-document discard has no `videoId` to key on, so forcing it into
   * that shape would be a worse fit than a small, dedicated, timestamped-file store (the same
   * reasoning `migrationBackupsDir` above already uses for its own whole-database backups).
   */
  changeDraftsDiscardedBackupsDir: string;
  /** Directory holding the per-channel editorial-profile Automerge documents
   * (`src/lib/sync-gateway/editorial-profile/`, added 2026-09-22, `docs/roadmap/plans/
   * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3 -- its own document family, separate from
   * `changeDraftsDir` above, per the owner's "отдельными документами" decision). */
  editorialProfileDraftsDir: string;
  /** Local-only fallback exchange directory for the editorial-profile sync runner, mirroring
   * `changeDraftsSyncFallbackDir`'s identical reasoning. */
  editorialProfileSyncFallbackDir: string;
  /** Pre-discard backups of a channel's local editorial-profile document, mirroring
   * `changeDraftsDiscardedBackupsDir`'s identical reasoning. */
  editorialProfileDiscardedBackupsDir: string;
  /** Directory holding the single global ai-connections-catalog Automerge document
   * (`src/lib/sync-gateway/ai-connections-catalog/`, added 2026-09-22, `docs/roadmap/plans/
   * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3) -- unlike the two directories above, this
   * holds exactly one document (`ai_connections` has no `channel_id`, device/account-wide). */
  aiConnectionsCatalogDraftsDir: string;
  /** Local-only fallback exchange directory for the ai-connections-catalog sync runner. */
  aiConnectionsCatalogSyncFallbackDir: string;
  /** Pre-discard backups of the global ai-connections-catalog document. */
  aiConnectionsCatalogDiscardedBackupsDir: string;
  /** Path to the device-local bootstrap config JSON file. */
  bootstrapConfigPath: string;
  /** Path to the CLI/MCP active-user auth-context JSON file. */
  authContextPath: string;
};
