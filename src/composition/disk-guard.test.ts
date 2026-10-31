import assert from "node:assert/strict";
import test from "node:test";
import { systemTopicPoster } from "./disk-guard";

// BL-237: the disk alert goes to the HUB "System" topic through the topic's own outbox (no new sender) -- and only while the
// topic is active on this computer; otherwise nothing is queued (the hub would never take it) and the bell alone shows it.

function topic(active: boolean) {
  const queued: string[] = [];
  return { queued, view: async () => ({ active }), enqueue: async (text: string) => void queued.push(text) };
}

test("the topic active here: the message is queued once and reported as posted", async () => {
  const t = topic(true);
  assert.equal(await systemTopicPoster(t)("Low disk space"), true);
  assert.deepEqual(t.queued, ["Low disk space"]);
});

test("the topic off here: nothing is queued and it reports not posted", async () => {
  const t = topic(false);
  assert.equal(await systemTopicPoster(t)("Low disk space"), false);
  assert.deepEqual(t.queued, []);
});
