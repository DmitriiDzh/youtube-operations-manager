import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { MusicLibraryResult } from "@/lib/music-library";
import { createMusicLibraryRouteHandlers } from "./handlers";

// BL-229 part A (AC-ML-06/07): the route needs a Web session and the active channel (AGENTS.md §F); the channel in the path is
// the only thing that picks the workspace; each library state comes back as it is.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });

function make(options: { session?: { user: { id: string } } | null; result?: MusicLibraryResult; fail?: Error } = {}) {
  const read: string[] = [];
  const handlers = createMusicLibraryRouteHandlers({
    getSession: async () => (options.session === undefined ? { user: { id: "owner" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
    },
    read: async (channelId) => {
      read.push(channelId);
      if (options.fail) throw options.fail;
      return options.result ?? { status: "no_file" };
    },
  });
  return { handlers, read };
}

test("no session is 401 and reads nothing", async () => {
  const { handlers, read } = make({ session: null });
  assert.equal((await handlers.get(new Request("http://x/"), ctx("UC_A"))).status, 401);
  assert.deepEqual(read, []);
});

test("AC-ML-07: another channel than the active one is refused (403) and no workspace is read", async () => {
  const { handlers, read } = make();
  const response = await handlers.get(new Request("http://x/"), ctx("UC_B"));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "CHANNEL_NOT_ACTIVE");
  assert.deepEqual(read, []);
});

test("AC-ML-06: each state is returned as it is, for the path's channel only", async () => {
  const states: MusicLibraryResult[] = [
    { status: "no_workspace" },
    { status: "workspace_unavailable", reason: "path does not exist" },
    { status: "no_file" },
    { status: "unreadable", reason: "genres: Invalid input" },
  ];
  for (const result of states) {
    const { handlers, read } = make({ result });
    const response = await handlers.get(new Request("http://x/"), ctx("UC_A"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.deepEqual(read, ["UC_A"]);
  }
});

test("an unexpected failure is a 500, not a library state", async () => {
  const { handlers } = make({ fail: new Error("EIO") });
  const response = await handlers.get(new Request("http://x/"), ctx("UC_A"));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "internal_error");
});
