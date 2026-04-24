import assert from "node:assert/strict";
import test from "node:test";
import { createCreatePlaylistPostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/youtube/create-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("create-playlist route preserves response envelope", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => ({
        playlist: {
          id: "p-created",
          title: "Roadtrip",
          description: "Summer videos",
          privacyStatus: "unlisted",
        },
      }),
    },
  });

  const response = await handler(
    makeRequest({ title: "Roadtrip", description: "Summer videos", privacyStatus: "unlisted" })
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(payload, {
    id: "p-created",
    title: "Roadtrip",
    description: "Summer videos",
    privacyStatus: "unlisted",
  });
});

test("create-playlist route rejects missing title", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => ({
        playlist: {
          id: "unused",
          title: "unused",
          description: "",
          privacyStatus: "private",
        },
      }),
    },
  });

  const response = await handler(makeRequest({ title: " " }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Title is required" });
});
