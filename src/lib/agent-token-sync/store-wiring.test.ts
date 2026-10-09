import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTokenStore } from "@/lib/agent-tokens/adapters/store";
import { createFactoryTokenStore } from "@/lib/factory-agent-tokens/adapters/store";
import { createProducerTokenStore } from "@/lib/producer-agent-tokens/adapters/store";
import { upsertChannel } from "@/lib/db";

// AC-ST-09 (docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §2), review round 1: the publish-at-once is wired in the three token stores
// themselves, so every issue, import, rotate and revoke -- whichever route or tool made it -- tells the other devices at once; a
// revoke that revoked nothing does not. Runs on this test process's isolated database.

test("AC-ST-09: each token store announces a stored or revoked token, and only then", async () => {
  await upsertChannel({ channelId: "UC_WIRE", title: "W", thumbnailUrl: null, uploadsPlaylistId: "UU_WIRE", connectedUserId: "user-wire" });
  const announced: string[] = [];
  const channel = createAgentTokenStore(() => announced.push("channel"));
  const factory = createFactoryTokenStore(() => announced.push("factory"));
  const producer = createProducerTokenStore(() => announced.push("producer"));

  await channel.replace({ id: "c1", channelId: "UC_WIRE", userId: "user-wire", tokenHash: "wire-c1", label: null });
  await factory.replace({ id: "f1", tokenHash: "wire-f1", label: null });
  await producer.replace({ id: "p1", tokenHash: "wire-p1", label: null });
  assert.deepEqual(announced, ["channel", "factory", "producer"]);

  assert.equal(await channel.revokeForChannel("UC_WIRE"), 1);
  assert.equal(await factory.revoke(), 1);
  assert.equal(await producer.revoke(), 1);
  assert.deepEqual(announced.slice(3), ["channel", "factory", "producer"]);

  // Nothing left to revoke: nothing to announce.
  assert.equal(await channel.revokeForChannel("UC_WIRE"), 0);
  assert.equal(await factory.revoke(), 0);
  assert.equal(await producer.revoke(), 0);
  assert.equal(announced.length, 6);
});
