import assert from "node:assert/strict";
import test from "node:test";
import { getStoredChannel, upsertChannel } from "@/lib/db";

// Architecture audit 2026-10-01 (H3): db.ts upsertChannel never changes or clears a stored owner
// unless it is given one.
test("AC-H3: upsertChannel keeps the stored connected_user_id when none is supplied, and never clears it", async () => {
  await upsertChannel({ channelId: "UC_H3", title: "A", thumbnailUrl: null, uploadsPlaylistId: "UU_H3", connectedUserId: "owner" });
  await upsertChannel({ channelId: "UC_H3", title: "B", thumbnailUrl: null, uploadsPlaylistId: "UU_H3" });
  await upsertChannel({ channelId: "UC_H3", title: "C", thumbnailUrl: null, uploadsPlaylistId: "UU_H3", connectedUserId: null });
  const channel = await getStoredChannel("UC_H3");
  assert.equal(channel?.title, "C");
  assert.equal(channel?.connectedUserId, "owner");

  await upsertChannel({ channelId: "UC_H3", title: "D", thumbnailUrl: null, uploadsPlaylistId: "UU_H3", connectedUserId: "new-owner" });
  assert.equal((await getStoredChannel("UC_H3"))?.connectedUserId, "new-owner");
});
