import path from "node:path";
import { APP_DIRECTORY_NAME, type AppPaths, type ResolveAppPathsInput } from "./contracts";

/**
 * Resolves the platform-appropriate root app-data directory. A pure function -- takes
 * platform/env/homedir as explicit input instead of reading process.platform/process.env
 * at the call site, so both Windows and macOS behavior are unit-testable from one machine
 * (see docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md AC-PATH-01/02).
 */
function resolveAppDataDir(input: ResolveAppPathsInput): string {
  const { platform, env, homedir } = input;

  if (platform === "win32") {
    // Standard Windows per-user roaming app-data location. Fall back to the well-known
    // default derived from homedir if APPDATA is unset (AC-PATH-03) -- never throw, never
    // fall back to a cwd-relative path.
    const base = env.APPDATA && env.APPDATA.length > 0
      ? env.APPDATA
      : path.join(homedir, "AppData", "Roaming");
    return path.join(base, APP_DIRECTORY_NAME);
  }

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", APP_DIRECTORY_NAME);
  }

  // Not an officially targeted platform for this task (Windows/macOS only), but never throw --
  // fall back to the XDG convention so a Linux dev environment still works predictably.
  const xdgBase = env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : path.join(homedir, ".local", "share");
  return path.join(xdgBase, APP_DIRECTORY_NAME);
}

export function resolveAppPaths(input: ResolveAppPathsInput): AppPaths {
  const appDataDir = resolveAppDataDir(input);

  return {
    appDataDir,
    dbPath: path.join(appDataDir, "playlist-manager.db"),
    backupsDir: path.join(appDataDir, "backups"),
    migrationBackupsDir: path.join(appDataDir, "backups", "migrations"),
    snapshotsDir: path.join(appDataDir, "snapshots"),
    changeDraftsDir: path.join(appDataDir, "change-drafts"),
    changeDraftsSyncFallbackDir: path.join(appDataDir, "change-drafts-sync-local"),
    changeDraftsDiscardedBackupsDir: path.join(appDataDir, "change-drafts-discarded-backups"),
    mediaSettingsDocDir: path.join(appDataDir, "media-settings-doc"),
    mediaSettingsSyncFallbackDir: path.join(appDataDir, "media-settings-sync-local"),
    mediaSettingsDiscardedBackupsDir: path.join(appDataDir, "media-settings-discarded-backups"),
    channelLanguageSettingsDocDir: path.join(appDataDir, "channel-language-settings-doc"),
    channelLanguageSettingsSyncFallbackDir: path.join(appDataDir, "channel-language-settings-sync-local"),
    channelLanguageSettingsDiscardedBackupsDir: path.join(appDataDir, "channel-language-settings-discarded-backups"),
    channelPublishingSettingsDocDir: path.join(appDataDir, "channel-publishing-settings-doc"),
    channelPublishingSettingsSyncFallbackDir: path.join(appDataDir, "channel-publishing-settings-sync-local"),
    channelPublishingSettingsDiscardedBackupsDir: path.join(appDataDir, "channel-publishing-settings-discarded-backups"),
    editorialProfileDraftsDir: path.join(appDataDir, "editorial-profile-drafts"),
    editorialProfileSyncFallbackDir: path.join(appDataDir, "editorial-profile-sync-local"),
    editorialProfileDiscardedBackupsDir: path.join(appDataDir, "editorial-profile-discarded-backups"),
    aiConnectionsCatalogDraftsDir: path.join(appDataDir, "ai-connections-catalog-drafts"),
    aiConnectionsCatalogSyncFallbackDir: path.join(appDataDir, "ai-connections-catalog-sync-local"),
    aiConnectionsCatalogDiscardedBackupsDir: path.join(appDataDir, "ai-connections-catalog-discarded-backups"),
    mediaSessionsShareDir: path.join(appDataDir, "media-sessions-share"),
    mediaSessionsSyncFallbackDir: path.join(appDataDir, "media-sessions-sync-local"),
    generationPlansShareDir: path.join(appDataDir, "generation-plans-share"),
    generationPlansSyncFallbackDir: path.join(appDataDir, "generation-plans-sync-local"),
    agentTokensShareDir: path.join(appDataDir, "agent-tokens-share"),
    agentTokensSyncFallbackDir: path.join(appDataDir, "agent-tokens-sync-local"),
    liveStreamsBufferDir: path.join(appDataDir, "live-streams"),
    liveStreamsThumbnailsDir: path.join(appDataDir, "live-streams-thumbnails"),
    liveStreamsShareDir: path.join(appDataDir, "live-streams-share"),
    liveStreamsSyncFallbackDir: path.join(appDataDir, "live-streams-sync-local"),
    publishingUploadsShareDir: path.join(appDataDir, "publishing-uploads-share"),
    publishingUploadsSyncFallbackDir: path.join(appDataDir, "publishing-uploads-sync-local"),
    mediaJobsShareDir: path.join(appDataDir, "media-jobs-share"),
    mediaJobsSyncFallbackDir: path.join(appDataDir, "media-jobs-sync-local"),
    videoReservationsShareDir: path.join(appDataDir, "video-reservations-share"),
    videoReservationsSyncFallbackDir: path.join(appDataDir, "video-reservations-sync-local"),
    videoCostsShareDir: path.join(appDataDir, "video-costs-share"),
    videoCostsSyncFallbackDir: path.join(appDataDir, "video-costs-sync-local"),
    liveAnalyticsShareDir: path.join(appDataDir, "live-analytics-share"),
    liveAnalyticsSyncFallbackDir: path.join(appDataDir, "live-analytics-sync-local"),
    geminiSpendShareDir: path.join(appDataDir, "gemini-spend-share"),
    geminiSpendSyncFallbackDir: path.join(appDataDir, "gemini-spend-sync-local"),
    geminiSettingsDocDir: path.join(appDataDir, "gemini-settings-doc"),
    geminiSettingsSyncFallbackDir: path.join(appDataDir, "gemini-settings-sync-local"),
    geminiSettingsDiscardedBackupsDir: path.join(appDataDir, "gemini-settings-discarded-backups"),
    storyboardsDocDir: path.join(appDataDir, "storyboards-doc"),
    storyboardsSyncFallbackDir: path.join(appDataDir, "storyboards-sync-local"),
    storyboardsDiscardedBackupsDir: path.join(appDataDir, "storyboards-discarded-backups"),
    bootstrapConfigPath: path.join(appDataDir, "bootstrap-config.json"),
    authContextPath: path.join(appDataDir, "auth-context.json"),
  };
}

/**
 * The legacy, pre-this-task data location (`<repo>/data/`), kept resolvable only as a
 * one-time migration *source* (decision 5) -- never the new home for any file.
 */
export function resolveLegacyDataDir(cwd: string): string {
  return path.join(cwd, "data");
}

export function resolveLegacyDbPath(cwd: string): string {
  return path.join(resolveLegacyDataDir(cwd), "playlist-manager.db");
}
