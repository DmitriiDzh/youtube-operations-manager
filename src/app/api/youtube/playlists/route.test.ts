import assert from "node:assert/strict";
import test from "node:test";
import { createPlaylistsGetHandler } from "./route";

test("playlists route returns list payload on happy path", async () => {
  const handler = createPlaylistsGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      listPlaylists: async () => ({
        playlists: [
          {
            id: "p1",
            title: "Playlist 1",
            description: "Roadtrip videos",
            privacyStatus: "private",
          },
        ],
      }),
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, [
    {
      id: "p1",
      title: "Playlist 1",
      description: "Roadtrip videos",
      privacyStatus: "private",
    },
  ]);
});

test("playlists route returns unauthorized when session is missing", async () => {
  const handler = createPlaylistsGetHandler({
    getSession: async () => null,
    core: {
      listPlaylists: async () => ({ playlists: [] }),
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "Unauthorized" });
});
