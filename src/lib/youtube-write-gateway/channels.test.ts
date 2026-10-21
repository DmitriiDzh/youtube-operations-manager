import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import * as gateway from "./index";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md "API facts", ADR 0047): the channel write primitive sends exactly ONE part (the API takes one
// part per request) with the body given. Owner msg 3350: the app never writes a channel's brandingSettings, so the gateway has no
// such primitive. Expected values by hand from developers.google.com/youtube/v3/docs/channels/update.

function fakeChannelsClient(calls: unknown[]): youtube_v3.Youtube {
  return { channels: { update: async (args: unknown) => (calls.push(args), { data: {} }) } } as unknown as youtube_v3.Youtube;
}

test("updateChannelLocalizations sends part=localizations with the full map and nothing else", async () => {
  const calls: unknown[] = [];
  const localizations = { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } };
  await gateway.updateChannelLocalizations({ youtube: fakeChannelsClient(calls), channelId: "UC1", localizations });
  assert.deepEqual(calls, [{ part: ["localizations"], requestBody: { id: "UC1", localizations: { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } } } }]);
});

test("owner msg 3350: the gateway exports no channel brandingSettings write", () => {
  assert.deepEqual(Object.keys(gateway).filter((name) => /branding/i.test(name)), []);
});
