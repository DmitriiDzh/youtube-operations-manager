import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appDataPaths, setChannelWorkspacePath, upsertChannel, upsertVideos } from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createVideoDetailsLocalCacheAdapter } from "@/lib/video-details/adapters/store";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { packageScanSignature } from "./index";
import { createPackageScanSignature, type ScanSignatureDeps } from "./scan-signature";

// Review of BL-270 (finding 2). Requirement: a kept package scan is reused past the first minute only while what it read is
// unchanged. The scan reads the channel's videos rows (privacy, publishAt, title, description, ...), which `video-details` rewrites
// in the local copy after a veto, a plan date, a Producer move or a package-metadata apply (finding 2).

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

test("BL-270 review (negative): no workspace or an unreadable part gives no signature (nothing is reused)", async () => {
  const base: ScanSignatureDeps = {
    workspace: async () => "/ws",
    folderSignature: async () => "f",
    removedVideos: async () => [],
    channelTimes: async () => null,
    videos: async () => [],
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
});
