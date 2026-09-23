import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAppPaths, resolveLegacyDataDir, resolveLegacyDbPath } from "./services";

// AC-PATH-01
test("resolveAppPaths: Windows resolves under APPDATA", () => {
  const result = resolveAppPaths({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\op\\AppData\\Roaming" },
    homedir: "C:\\Users\\op",
  });

  assert.equal(
    result.appDataDir,
    path.join("C:\\Users\\op\\AppData\\Roaming", "YouTubeOperationsManager")
  );
  assert.equal(result.dbPath, path.join(result.appDataDir, "playlist-manager.db"));
  assert.equal(result.backupsDir, path.join(result.appDataDir, "backups"));
  assert.equal(result.snapshotsDir, path.join(result.appDataDir, "snapshots"));
  assert.equal(result.changeDraftsDir, path.join(result.appDataDir, "change-drafts"));
  assert.equal(result.changeDraftsSyncFallbackDir, path.join(result.appDataDir, "change-drafts-sync-local"));
  assert.equal(result.changeDraftsDiscardedBackupsDir, path.join(result.appDataDir, "change-drafts-discarded-backups"));
  assert.equal(result.editorialProfileDraftsDir, path.join(result.appDataDir, "editorial-profile-drafts"));
  assert.equal(result.editorialProfileSyncFallbackDir, path.join(result.appDataDir, "editorial-profile-sync-local"));
  assert.equal(result.editorialProfileDiscardedBackupsDir, path.join(result.appDataDir, "editorial-profile-discarded-backups"));
  assert.equal(result.aiConnectionsCatalogDraftsDir, path.join(result.appDataDir, "ai-connections-catalog-drafts"));
  assert.equal(result.aiConnectionsCatalogSyncFallbackDir, path.join(result.appDataDir, "ai-connections-catalog-sync-local"));
  assert.equal(result.aiConnectionsCatalogDiscardedBackupsDir, path.join(result.appDataDir, "ai-connections-catalog-discarded-backups"));
  assert.equal(result.bootstrapConfigPath, path.join(result.appDataDir, "bootstrap-config.json"));
});

// AC-PATH-02
test("resolveAppPaths: macOS resolves under ~/Library/Application Support", () => {
  const result = resolveAppPaths({
    platform: "darwin",
    env: {},
    homedir: "/Users/op",
  });

  assert.equal(
    result.appDataDir,
    path.join("/Users/op", "Library", "Application Support", "YouTubeOperationsManager")
  );
});

// AC-PATH-03
test("resolveAppPaths: Windows without APPDATA falls back to homedir-derived default, never throws", () => {
  const result = resolveAppPaths({
    platform: "win32",
    env: {},
    homedir: "C:\\Users\\op",
  });

  assert.equal(
    result.appDataDir,
    path.join("C:\\Users\\op", "AppData", "Roaming", "YouTubeOperationsManager")
  );
});

test("resolveAppPaths: never falls back to a cwd-relative path regardless of platform", () => {
  const winResult = resolveAppPaths({ platform: "win32", env: {}, homedir: "/home/op" });
  const macResult = resolveAppPaths({ platform: "darwin", env: {}, homedir: "/home/op" });
  const linuxResult = resolveAppPaths({ platform: "linux", env: {}, homedir: "/home/op" });

  for (const result of [winResult, macResult, linuxResult]) {
    assert.ok(path.isAbsolute(result.appDataDir), "appDataDir must be absolute");
    assert.ok(!result.appDataDir.includes(process.cwd()), "must not be derived from cwd");
  }
});

test("resolveLegacyDataDir / resolveLegacyDbPath point at <cwd>/data (migration source only)", () => {
  const cwd = "C:\\repo";
  assert.equal(resolveLegacyDataDir(cwd), path.join(cwd, "data"));
  assert.equal(resolveLegacyDbPath(cwd), path.join(cwd, "data", "playlist-manager.db"));
});
