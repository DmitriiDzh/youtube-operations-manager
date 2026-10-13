import assert from "node:assert/strict";
import test from "node:test";
import { createStoryboardAlertsHandler } from "./route";

// BL-184 stage 1: per connected channel, only the storyboards waiting for the owner (in_review) count; one channel that fails to
// read never hides the others; a session is required.

const row = (storyboardId: string, state: "draft" | "in_review" | "changes_requested" | "approved") => ({ storyboardId, state }) as never;

test("waiting storyboards per channel; a failing channel is skipped; 401 without a session", async () => {
  const make = (session: { user: { id: string } } | null) =>
    createStoryboardAlertsHandler({
      getSession: async () => session,
      activeChannelId: async () => "UC_a",
      connectedChannelIds: async () => ["UC_a", "UC_b", "UC_broken", "UC_quiet"],
      list: async (channelId) => {
        if (channelId === "UC_broken") throw new Error("unreadable");
        if (channelId === "UC_a") return [row("s1", "in_review"), row("s2", "in_review"), row("s3", "approved")];
        if (channelId === "UC_b") return [row("bar", "in_review"), row("x", "draft"), row("y", "changes_requested")];
        return [row("q", "approved")];
      },
    });
  assert.equal((await make(null)()).status, 401);
  const response = await make({ user: { id: "owner" } })();
  assert.deepEqual(await response.json(), {
    activeChannelId: "UC_a",
    channels: [
      { channelId: "UC_a", waiting: 2, storyboardId: null },
      { channelId: "UC_b", waiting: 1, storyboardId: "bar" },
    ],
  });
});
