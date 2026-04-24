import assert from "node:assert/strict";
import test from "node:test";
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
    makeRequest({ playlistId: "p1", videoIds: ["v1", "v2"] })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { removed: 1 });
});

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

  const response = await handler(makeRequest({ playlistId: "p1" }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Missing videoIds or playlistId" });
});
