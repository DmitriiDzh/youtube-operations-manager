import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appDataPaths, setChannelWorkspacePath, upsertChannel, upsertVideos } from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createVideoDetailsLocalCacheAdapter } from "@/lib/video-details/adapters/store";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { packageScanFilesSignature, packageScanSignature } from "./index";
import { createPackageScanSignature, referencedFilesOf, type ScanSignatureDeps } from "./scan-signature";
import type { ScannedPackage } from "./package-scan";

// Review of BL-270 (findings 2, 3). Requirement: a kept package scan is reused past the first minute only while what it read is
// unchanged. The scan reads the channel's videos rows (privacy, publishAt, title, description, ...), which `video-details` rewrites
// in the local copy after a veto, a plan date, a Producer move or a package-metadata apply (finding 2); and it reads the files its
// manifests name, which may sit below the folder walk's depth or behind a symlink (finding 3).

function snapshotAfter(overrides: Partial<VideoDetailsSnapshot>): VideoDetailsSnapshot {
  return {
    videoId: "vid-1",
    etag: "e1",
    title: "Title",
    description: "Desc",
    tags: [],
    categoryId: null,
    defaultLanguage: "en",
    defaultAudioLanguage: null,
    privacyStatus: "private",
    publishAt: "2026-11-20T17:00:00Z",
    license: null,
    embeddable: null,
    publicStatsViewable: null,
    selfDeclaredMadeForKids: null,
    containsSyntheticMedia: null,
    recordingDate: null,
    ...overrides,
  };
}

test("BL-270 review (finding 2): a video-details local-copy write (a veto clears publishAt) moves the scan signature", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "scan-sig-ws-"));
  try {
    await mkdir(path.join(workspace, "04 Videos", "11 November", "1117 V12"), { recursive: true });
    await writeFile(path.join(workspace, "04 Videos", "11 November", "1117 V12", "V12_release.json"), "{}");
    await upsertChannel({ channelId: "UC_SIG", title: "Sig", thumbnailUrl: null, uploadsPlaylistId: "UU_SIG", connectedUserId: null });
    await upsertVideos(
      [
        {
          videoId: "vid-1",
          channelId: "UC_SIG",
          title: "Title",
          description: "Desc",
          publishedAt: "2026-11-17T10:00:00Z",
          privacyStatus: "private",
          defaultLanguage: "en",
          defaultAudioLanguage: null,
          thumbnails: {},
          existingLocalizations: {},
          etag: "e1",
          publishAt: "2026-11-20T17:00:00Z",
        },
      ] as never,
      new Date("2026-11-17T10:00:00Z")
    );
    const { deviceId } = await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists();
    await setChannelWorkspacePath(deviceId, "UC_SIG", workspace);

    const before = await packageScanSignature("UC_SIG");
    assert.ok(before, "a configured workspace has a signature");
    assert.equal(await packageScanSignature("UC_SIG"), before, "stable while nothing changes");
    // The owner's veto: video-details removes the date and refreshes the local copy through its own adapter.
    await createVideoDetailsLocalCacheAdapter().refreshVideoFields({ channelId: "UC_SIG", videoId: "vid-1", after: snapshotAfter({ publishAt: null }) });
    const afterVeto = await packageScanSignature("UC_SIG");
    assert.notEqual(afterVeto, before);
    // A package-metadata apply: only the title changes.
    await createVideoDetailsLocalCacheAdapter().refreshVideoFields({ channelId: "UC_SIG", videoId: "vid-1", after: snapshotAfter({ publishAt: null, title: "New title" }) });
    assert.notEqual(await packageScanSignature("UC_SIG"), afterVeto);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function pkg(folder: string, video: string, thumbnails: string[] = []): ScannedPackage {
  return {
    manifestPath: `${folder}/${video}_release.json`,
    folder,
    pkg: { video, files: { video: `renders/${video}.mp4`, thumbnail: `${video}.jpg` }, thumbnails: thumbnails.map((file) => ({ file, role: "test" })) },
  } as unknown as ScannedPackage;
}

test("BL-270 review (finding 3): the files a package names are listed, deeper paths included", () => {
  assert.deepEqual(referencedFilesOf(pkg("04 Videos/11 November/1117 V12", "V12", ["t2.jpg"])), [
    "04 Videos/11 November/1117 V12/V12_release.json",
    "04 Videos/11 November/1117 V12/renders/V12.mp4",
    "04 Videos/11 November/1117 V12/V12.jpg",
    "04 Videos/11 November/1117 V12/V12_youtube.json",
    "04 Videos/11 November/1117 V12/t2.jpg",
  ]);
});

test("BL-270 review (finding 3): a re-render below the walk's depth, and a symlink pointed elsewhere, move the files signature", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "scan-sig-files-"));
  try {
    await mkdir(path.join(workspace, "04 Videos", "11 November", "1117 V12", "renders"), { recursive: true });
    await mkdir(path.join(workspace, "elsewhere"), { recursive: true });
    const folder = "04 Videos/11 November/1117 V12";
    const at = (rel: string) => path.join(workspace, ...rel.split("/"));
    await writeFile(at(`${folder}/V12_release.json`), "{}");
    await writeFile(at(`${folder}/renders/V12.mp4`), "video-1");
    await writeFile(at("elsewhere/a.jpg"), "AAAA");
    await writeFile(at("elsewhere/b.jpg"), "BBBB");
    await symlink(at("elsewhere/a.jpg"), at(`${folder}/V12.jpg`));
    const old = new Date("2026-11-01T00:00:00Z");
    for (const rel of [`${folder}/V12_release.json`, `${folder}/renders/V12.mp4`, "elsewhere/a.jpg", "elsewhere/b.jpg"]) await utimes(at(rel), old, old);
    const { deviceId } = await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists();
    await upsertChannel({ channelId: "UC_FILES", title: "Files", thumbnailUrl: null, uploadsPlaylistId: "UU_FILES", connectedUserId: null });
    await setChannelWorkspacePath(deviceId, "UC_FILES", workspace);
    const packages = [pkg(folder, "V12")];

    const first = await packageScanFilesSignature("UC_FILES", packages);
    assert.ok(first);
    assert.equal(first.newestMtimeMs, old.getTime());
    assert.equal((await packageScanFilesSignature("UC_FILES", packages))?.key, first.key, "stable");
    // A re-render at depth 5 (below the folder walk's depth 3): same size, new modification time.
    await writeFile(at(`${folder}/renders/V12.mp4`), "video-2");
    const rerendered = await packageScanFilesSignature("UC_FILES", packages);
    assert.notEqual(rerendered?.key, first.key);
    assert.ok((rerendered?.newestMtimeMs ?? 0) > old.getTime());
    // The thumbnail link pointed at another file with the same size and time.
    await rm(at(`${folder}/V12.jpg`));
    await symlink(at("elsewhere/b.jpg"), at(`${folder}/V12.jpg`));
    assert.notEqual((await packageScanFilesSignature("UC_FILES", packages))?.key, rerendered?.key);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("BL-270 review (negative): no workspace or an unreadable part gives no signature (nothing is reused)", async () => {
  const base: ScanSignatureDeps = {
    workspace: async () => "/ws",
    folderSignature: async () => "f",
    removedVideos: async () => [],
    channelTimes: async () => null,
    videos: async () => [],
    stat: async () => null,
    join: (...parts) => parts.join("/"),
  };
  assert.equal(await createPackageScanSignature({ ...base, workspace: async () => null }).signature("UC"), null);
  assert.equal(
    await createPackageScanSignature({
      ...base,
      videos: async () => {
        throw new Error("db busy");
      },
    }).signature("UC"),
    null
  );
  assert.equal(await createPackageScanSignature({ ...base, workspace: async () => null }).filesSignature("UC", []), null);
});
