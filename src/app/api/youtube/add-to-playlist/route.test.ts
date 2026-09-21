import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/playlist-management/contracts";
import { createAddToPlaylistPostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/youtube/add-to-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("add-to-playlist route preserves added counter envelope", async () => {
  const handler = createAddToPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      addVideosToPlaylist: async () => ({
        playlistId: "p1",
        attempted: 2,
        added: 1,
        failures: [{ videoId: "v2", reason: "already-present" }],
      }),
    },
  });

  const response = await handler(
    makeRequest({ playlistId: "p1", videoIds: ["v1", "v2"] })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { added: 1 });
});

test("add-to-playlist route rejects missing params", async () => {
  const handler = createAddToPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      addVideosToPlaylist: async () => ({
        playlistId: "p1",
        attempted: 0,
        added: 0,
        failures: [],
      }),
    },
  });

  const response = await handler(makeRequest({ playlistId: "p1" }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Missing videoIds or playlistId" });
});

// Regression test: see the matching test in ../create-playlist/route.test.ts for why this
// exists -- a DomainError from the core previously propagated uncaught as a bare 500.
test("add-to-playlist route surfaces a DomainError as a structured JSON error, not a bare 500", async () => {
  const handler = createAddToPlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      addVideosToPlaylist: async () => {
        throw new DomainError({ code: "live_writes_disabled", message: "Real YouTube write execution is disabled" });
      },
    },
  });

  const response = await handler(makeRequest({ playlistId: "p1", videoIds: ["v1"] }));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    error: "live_writes_disabled",
    message: "Real YouTube write execution is disabled",
  });
});
