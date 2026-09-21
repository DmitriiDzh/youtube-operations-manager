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
  /** Path to the device-local bootstrap config JSON file. */
  bootstrapConfigPath: string;
  /** Path to the CLI/MCP active-user auth-context JSON file. */
  authContextPath: string;
};
