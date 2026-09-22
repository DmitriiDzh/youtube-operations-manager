import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { getLiveWritesEnabled, setLiveWritesEnabled } from "@/lib/db";
import { DomainError } from "./contracts";
import {
  addVideoToPlaylistForAuthenticated,
  applyVideoDetailsUpdate,
  applyVideoMetadataUpdate,
  assertLiveWritesAuthorized,
  createPlaylistForAuthenticated,
  deletePlaylistForAuthenticated,
  deletePlaylistItemById,
  pickWritableRecordingDetailsFields,
  pickWritableSnippetFields,
  pickWritableStatusFields,
  updatePlaylistForAuthenticated,
} from "./index";

function fakeYoutubeClient(overrides: {
  videosUpdate?: youtube_v3.Youtube["videos"]["update"];
  playlistsInsert?: youtube_v3.Youtube["playlists"]["insert"];
  playlistsUpdate?: youtube_v3.Youtube["playlists"]["update"];
  playlistsDelete?: youtube_v3.Youtube["playlists"]["delete"];
  playlistItemsInsert?: youtube_v3.Youtube["playlistItems"]["insert"];
  playlistItemsDelete?: youtube_v3.Youtube["playlistItems"]["delete"];
}): youtube_v3.Youtube {
  return {
    videos: { update: overrides.videosUpdate },
    playlists: {
      insert: overrides.playlistsInsert,
      update: overrides.playlistsUpdate,
      delete: overrides.playlistsDelete,
    },
    playlistItems: {
      insert: overrides.playlistItemsInsert,
      delete: overrides.playlistItemsDelete,
    },
  } as unknown as youtube_v3.Youtube;
}

// ---------------------------------------------------------------------------
// assertLiveWritesAuthorized -- moved here from write-executor.youtube.ts (2026-09-21
// single-funnel refactor). Every process boot forces live_writes_enabled back to false
// (src/lib/db.ts's initializeDatabase), so a sanity check that it starts false is safe here.
// ---------------------------------------------------------------------------

test("assertLiveWritesAuthorized: throws a live_writes_disabled DomainError when the setting is off", async () => {
  const alreadyEnabled = await getLiveWritesEnabled();
  assert.equal(alreadyEnabled, false, "sanity check -- every process boot forces this off");

  await assert.rejects(
    () => assertLiveWritesAuthorized(),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
});

test("assertLiveWritesAuthorized: resolves once the persisted setting is on", async () => {
  await setLiveWritesEnabled(true);
  try {
    await assertLiveWritesAuthorized();
  } finally {
    await setLiveWritesEnabled(false);
  }
});

// ---------------------------------------------------------------------------
// src/lib/video-details/'s underlying merge/write primitives (Studio-parity "Details" edit).
// Acceptance matrix from the owner's own requirement (Telegram: "чтобы мы могли поменять
// что-то одно при этом не перезаписывая все остальные параметры") and the OFFICIAL YouTube
// Data API v3 reference (checked live 2026-09-20):
//
// AC-DETAILS-01: patching only one snippet field preserves every other snippet field exactly.
// AC-DETAILS-02: a snippet-only patch sends no `status` part, and vice versa.
// AC-DETAILS-03: `localizations` is never part of the request body, under any parts combination.
// AC-DETAILS-04: `recordingDetails.location`/`locationDescription` are never forwarded, even if
//   present on the input object (deprecated fields, rejected by the live API today).
//
// These call the gateway's write primitives directly (not through an adapter/service), so
// they do not go through `assertLiveWritesAuthorized` and need no toggle setup -- matching
// `write-executor.youtube.test.ts`'s own `performYoutubeWrite` tests, which exercise the raw
// primitive the same way ("it has none -- that is the caller's job").
// ---------------------------------------------------------------------------

const BASE_VIDEO_ITEM = {
  etag: "etag-1",
  snippet: {
    title: "Original Title",
    description: "Original description",
    tags: ["a", "b"],
    categoryId: "22",
    defaultLanguage: "en",
  },
  status: {
    privacyStatus: "public",
    license: "youtube",
    embeddable: true,
    publicStatsViewable: true,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: false,
  },
  recordingDetails: { recordingDate: null },
};

test("AC-DETAILS-01/02: patching only title preserves every other snippet field and sends no status part", async () => {
  let updateCall: { part: string[]; requestBody: Record<string, unknown> } | null = null;
  const youtube = fakeYoutubeClient({
    videosUpdate: (async (args: { part: string[]; requestBody: Record<string, unknown> }) => {
      updateCall = args;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["videos"]["update"],
  });

  const patch = { title: "New Title" };
  await applyVideoDetailsUpdate({
    youtube,
    videoId: "v1",
    parts: {
      snippet: pickWritableSnippetFields({
        ...BASE_VIDEO_ITEM.snippet,
        ...patch,
      }) as youtube_v3.Schema$VideoSnippet,
    },
  });

  assert.ok(updateCall);
  const call = updateCall as unknown as { part: string[]; requestBody: { snippet?: Record<string, unknown> } };
  assert.deepEqual(call.part, ["snippet"]);
  assert.equal(call.requestBody.snippet?.title, "New Title");
  assert.equal(call.requestBody.snippet?.description, "Original description");
  assert.deepEqual(call.requestBody.snippet?.tags, ["a", "b"]);
  assert.equal(call.requestBody.snippet?.categoryId, "22");
  assert.equal(call.requestBody.snippet?.defaultLanguage, "en");
  assert.equal("status" in call.requestBody, false);
  assert.equal("recordingDetails" in call.requestBody, false);
});

test("AC-DETAILS-01: patching only privacyStatus preserves every other status field and sends no snippet part", async () => {
  let updateCall: { part: string[]; requestBody: Record<string, unknown> } | null = null;
  const youtube = fakeYoutubeClient({
    videosUpdate: (async (args: { part: string[]; requestBody: Record<string, unknown> }) => {
      updateCall = args;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["videos"]["update"],
  });

  await applyVideoDetailsUpdate({
    youtube,
    videoId: "v1",
    parts: {
      status: pickWritableStatusFields({
        ...BASE_VIDEO_ITEM.status,
        privacyStatus: "unlisted",
      }) as youtube_v3.Schema$VideoStatus,
    },
  });

  assert.ok(updateCall);
  const call = updateCall as unknown as { part: string[]; requestBody: { status?: Record<string, unknown> } };
  assert.deepEqual(call.part, ["status"]);
  assert.equal(call.requestBody.status?.privacyStatus, "unlisted");
  assert.equal(call.requestBody.status?.license, "youtube");
  assert.equal(call.requestBody.status?.embeddable, true);
  assert.equal("snippet" in call.requestBody, false);
});

test("AC-DETAILS-03: localizations is never part of the request body, under any parts combination", async () => {
  let updateCall: { requestBody: Record<string, unknown> } | null = null;
  const youtube = fakeYoutubeClient({
    videosUpdate: (async (args: { requestBody: Record<string, unknown> }) => {
      updateCall = args;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["videos"]["update"],
  });

  await applyVideoDetailsUpdate({
    youtube,
    videoId: "v1",
    parts: {
      snippet: { title: "X" } as youtube_v3.Schema$VideoSnippet,
      status: { privacyStatus: "private" } as youtube_v3.Schema$VideoStatus,
      recordingDetails: { recordingDate: "2026-01-01" },
    },
  });

  assert.ok(updateCall);
  assert.equal("localizations" in (updateCall as unknown as { requestBody: Record<string, unknown> }).requestBody, false);
});

test("AC-DETAILS-04: recordingDate is forwarded but deprecated location fields never are", () => {
  const picked = pickWritableRecordingDetailsFields({
    recordingDate: "2026-01-01T00:00:00Z",
    location: { latitude: 1, longitude: 2 },
    locationDescription: "Somewhere",
  });
  assert.deepEqual(picked, { recordingDate: "2026-01-01T00:00:00Z" });
});

test("applyVideoDetailsUpdate makes no network call at all when no parts are touched", async () => {
  let called = false;
  const youtube = fakeYoutubeClient({
    videosUpdate: (async () => {
      called = true;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["videos"]["update"],
  });

  await applyVideoDetailsUpdate({ youtube, videoId: "v1", parts: {} });
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// applyVideoMetadataUpdate -- the title/description/localizations write primitive shared by
// the single-item `apply` path and (via write-executor.youtube.ts) the Batches pipeline.
// ---------------------------------------------------------------------------

test("applyVideoMetadataUpdate sends id/snippet/localizations exactly as given", async () => {
  let updateCall: unknown;
  const youtube = fakeYoutubeClient({
    videosUpdate: (async (args: unknown) => {
      updateCall = args;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["videos"]["update"],
  });

  await applyVideoMetadataUpdate({
    youtube,
    update: {
      videoId: "v1",
      snippet: { title: "T", description: "D" },
      localizations: { es: { title: "ES T", description: "ES D" } },
    },
  });

  const call = updateCall as { part: string[]; requestBody: { id: string; snippet: unknown; localizations: unknown } };
  assert.deepEqual(call.part, ["snippet", "localizations"]);
  assert.equal(call.requestBody.id, "v1");
  assert.deepEqual(call.requestBody.snippet, { title: "T", description: "D" });
  assert.deepEqual(call.requestBody.localizations, { es: { title: "ES T", description: "ES D" } });
});

// ---------------------------------------------------------------------------
// Playlist write primitives -- moved from what is now src/lib/youtube-read-gateway/data-api.ts
// (src/lib/youtube.ts at the time of this move), and (deletePlaylist) newly
// wrapped here so `playlists.delete` no longer lives inline in
// `playlist-management/adapters/youtube-api.ts` (owner instruction: the gateway is the only
// place allowed to make this call).
// ---------------------------------------------------------------------------

test("createPlaylistForAuthenticated sends title/description/privacyStatus and maps the response", async () => {
  const youtube = fakeYoutubeClient({
    playlistsInsert: (async () => ({
      data: { id: "PL1", snippet: { title: "My playlist", description: "desc" }, status: { privacyStatus: "unlisted" } },
    })) as unknown as youtube_v3.Youtube["playlists"]["insert"],
  });

  const playlist = await createPlaylistForAuthenticated(youtube, "My playlist", "unlisted", "desc");
  assert.deepEqual(playlist, { id: "PL1", title: "My playlist", description: "desc", privacyStatus: "unlisted" });
});

test("updatePlaylistForAuthenticated sends the patch and maps the response", async () => {
  const youtube = fakeYoutubeClient({
    playlistsUpdate: (async () => ({
      data: { id: "PL1", snippet: { title: "New title", description: "new desc" }, status: { privacyStatus: "public" } },
    })) as unknown as youtube_v3.Youtube["playlists"]["update"],
  });

  const playlist = await updatePlaylistForAuthenticated({
    youtube,
    playlistId: "PL1",
    title: "New title",
    description: "new desc",
    privacyStatus: "public",
  });
  assert.deepEqual(playlist, { id: "PL1", title: "New title", description: "new desc", privacyStatus: "public" });
});

test("deletePlaylistForAuthenticated calls playlists.delete with the given id", async () => {
  let deletedId: string | undefined;
  const youtube = fakeYoutubeClient({
    playlistsDelete: (async (args: { id?: string }) => {
      deletedId = args.id;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["playlists"]["delete"],
  });

  await deletePlaylistForAuthenticated(youtube, "PL1");
  assert.equal(deletedId, "PL1");
});

test("addVideoToPlaylistForAuthenticated inserts a playlistItem referencing the video", async () => {
  let insertedBody: unknown;
  const youtube = fakeYoutubeClient({
    playlistItemsInsert: (async (args: { requestBody: unknown }) => {
      insertedBody = args.requestBody;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["playlistItems"]["insert"],
  });

  await addVideoToPlaylistForAuthenticated(youtube, "v1", "PL1");
  assert.deepEqual(insertedBody, {
    snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "v1" } },
  });
});

test("deletePlaylistItemById calls playlistItems.delete with the given id", async () => {
  let deletedId: string | undefined;
  const youtube = fakeYoutubeClient({
    playlistItemsDelete: (async (args: { id?: string }) => {
      deletedId = args.id;
      return { data: {} };
    }) as unknown as youtube_v3.Youtube["playlistItems"]["delete"],
  });

  await deletePlaylistItemById(youtube, "PLI1");
  assert.equal(deletedId, "PLI1");
});
