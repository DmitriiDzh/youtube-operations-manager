import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/playlist-management/contracts";
import { createRemoveFromPlaylistPostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/youtube/remove-from-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("remove-from-playlist route preserves removed counter envelope", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      removeVideosFromPlaylist: async () => ({
        playlistId: "p1",
        requested: 2,
        removed: 1,
        failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
      }),
    },
  });

  const response = await handler(
    makeRequest({ playlistId: "p1", expectedChannelId: "UC_TEST", videoIds: ["v1", "v2"] })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { removed: 1 });
});

// Independent test-suite audit (2026-09-26): removeVideosFromPlaylist now requires
// expectedChannelId, mirroring the identity check every sibling write method already had
// (createPlaylist/updatePlaylist/deletePlaylist) -- this route's own "missing params" message
// and test updated to match.
test("remove-from-playlist route rejects missing params", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      removeVideosFromPlaylist: async () => ({
        playlistId: "p1",
        requested: 0,
        removed: 0,
        failures: [],
      }),
    },
  });

  const response = await handler(makeRequest({ playlistId: "p1", expectedChannelId: "UC_TEST" }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Missing videoIds, playlistId, or expectedChannelId" });
});

test("remove-from-playlist route rejects a request missing expectedChannelId specifically", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      removeVideosFromPlaylist: async () => ({ playlistId: "p1", requested: 0, removed: 0, failures: [] }),
    },
  });

  const response = await handler(makeRequest({ playlistId: "p1", videoIds: ["v1"] }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Missing videoIds, playlistId, or expectedChannelId" });
});

// Independent test-suite audit (2026-09-26): this route implements a 401 pre-auth check but had
// no test proving it, unlike its sibling GET route (../playlists/route.test.ts).
test("remove-from-playlist route returns unauthorized when session is missing", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => null,
    core: {
      removeVideosFromPlaylist: async () => ({ playlistId: "p1", requested: 0, removed: 0, failures: [] }),
    },
  });

  const response = await handler(makeRequest({ playlistId: "p1", videoIds: ["v1"] }));
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "Unauthorized" });
});

// Independent test-suite audit (2026-09-26): this route used to parse the request body with raw
// `request.json()` before entering its try block, so a malformed body threw an uncaught
// SyntaxError -> bare 500. Now routed through parseVideoMetadataJsonBody inside the try block.
test("remove-from-playlist route surfaces malformed JSON as a structured 400, not a bare 500", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      removeVideosFromPlaylist: async () => ({ playlistId: "p1", requested: 0, removed: 0, failures: [] }),
    },
  });

  const request = new Request("http://localhost/api/youtube/remove-from-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "validation_failed");
});

// Regression test: see the matching test in ../create-playlist/route.test.ts for why this
// exists -- a DomainError from the core previously propagated uncaught as a bare 500.
test("remove-from-playlist route surfaces a DomainError as a structured JSON error, not a bare 500", async () => {
  const handler = createRemoveFromPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      removeVideosFromPlaylist: async () => {
        throw new DomainError({ code: "live_writes_disabled", message: "Real YouTube write execution is disabled" });
      },
    },
  });

  const response = await handler(
    makeRequest({ playlistId: "p1", expectedChannelId: "UC_TEST", videoIds: ["v1"] })
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    error: "live_writes_disabled",
    message: "Real YouTube write execution is disabled",
  });
});
