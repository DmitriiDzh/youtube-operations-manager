import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import * as gateway from "./index";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md "API facts", ADR 0047): the channel write primitive sends exactly ONE part (the API takes one
// part per request) with the body given. Owner msg 3350 (no brandingSettings write) was lifted for the
// description, keywords and banner by msgs 3482/3488 (ADR 0050). Expected values by hand from developers.google.com/youtube/v3/docs/channels/update.

function fakeChannelsClient(calls: unknown[]): youtube_v3.Youtube {
  return { channels: { update: async (args: unknown) => (calls.push(args), { data: {} }) } } as unknown as youtube_v3.Youtube;
}

test("updateChannelLocalizations sends part=localizations with the full map and nothing else", async () => {
  const calls: unknown[] = [];
  const localizations = { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } };
  await gateway.updateChannelLocalizations({ youtube: fakeChannelsClient(calls), channelId: "UC1", localizations });
  assert.deepEqual(calls, [{ part: ["localizations"], requestBody: { id: "UC1", localizations: { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } } } }]);
});

// This test asserted "no branding export at all" (owner msg 3350). The requirement changed: owner msgs 3482/3488 (ADR 0050, BL-223)
// authorize exactly one brandingSettings write and the banner upload, so it now names exactly those two.
test("ADR 0050: the gateway's only channel branding exports are the brandingSettings update and the banner upload", () => {
  assert.deepEqual(Object.keys(gateway).filter((name) => /branding|banner/i.test(name) && typeof (gateway as Record<string, unknown>)[name] === "function").sort(), ["insertChannelBanner", "updateChannelBrandingSettings"]);
});

// BL-223 (CHANNEL_BRANDING_PLAN.md "API facts", U1/U3/U4): channels.update takes ONE part, here brandingSettings with the body given;
// channelBanners.insert takes the image as media (no request body) and answers { url }.
test("updateChannelBrandingSettings sends part=brandingSettings with exactly the body given", async () => {
  const calls: unknown[] = [];
  const brandingSettings = { channel: { title: "T", description: "D", keywords: "a b", country: "US" }, image: { bannerExternalUrl: "https://b/1" } };
  await gateway.updateChannelBrandingSettings({ youtube: fakeChannelsClient(calls), channelId: "UC1", brandingSettings });
  assert.deepEqual(calls, [{ part: ["brandingSettings"], requestBody: { id: "UC1", brandingSettings: { channel: { title: "T", description: "D", keywords: "a b", country: "US" }, image: { bannerExternalUrl: "https://b/1" } } } }]);
});

test("insertChannelBanner uploads the bytes as media and returns YouTube's url; refuses over 6 MB and an answer without url", async () => {
  const calls: Array<{ media: { mimeType: string; body: NodeJS.ReadableStream } }> = [];
  let answer: unknown = { data: { kind: "youtube#channelBannerResource", url: "https://yt3/banner" } };
  const youtube = { channelBanners: { insert: async (args: { media: { mimeType: string; body: NodeJS.ReadableStream } }) => (calls.push(args), answer) } } as unknown as youtube_v3.Youtube;
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(await gateway.insertChannelBanner(youtube, { mimeType: "image/png", bytes }), { url: "https://yt3/banner" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].media.mimeType, "image/png");
  const sent: Buffer[] = [];
  for await (const chunk of calls[0].media.body) sent.push(Buffer.from(chunk as Buffer));
  assert.deepEqual(Buffer.concat(sent), bytes);
  await assert.rejects(gateway.insertChannelBanner(youtube, { mimeType: "image/png", bytes: Buffer.alloc(6 * 1024 * 1024 + 1) }), { code: "validation_failed" });
  assert.equal(calls.length, 1, "nothing sent over 6 MB");
  answer = { data: {} };
  await assert.rejects(gateway.insertChannelBanner(youtube, { mimeType: "image/png", bytes }), { code: "update_failed" });
});
