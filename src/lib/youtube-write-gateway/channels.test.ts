import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { pickSettableBrandingChannelFields, updateChannelBrandingChannel, updateChannelLocalizations } from "./index";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md "API facts", ADR 0047): the two channel write primitives send exactly ONE part each (the API
// takes one part per request) with the body given; the branding pick keeps exactly the settable fields read with a value, never the
// title (channelTitleUpdateForbidden). Expected values by hand from developers.google.com/youtube/v3/docs/channels/update.

function fakeChannelsClient(calls: unknown[]): youtube_v3.Youtube {
  return { channels: { update: async (args: unknown) => (calls.push(args), { data: {} }) } } as unknown as youtube_v3.Youtube;
}

test("updateChannelLocalizations sends part=localizations with the full map and nothing else", async () => {
  const calls: unknown[] = [];
  const localizations = { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } };
  await updateChannelLocalizations({ youtube: fakeChannelsClient(calls), channelId: "UC1", localizations });
  assert.deepEqual(calls, [{ part: ["localizations"], requestBody: { id: "UC1", localizations: { fr: { title: "Fr", description: "Fd" }, de: { title: "De", description: "Dd" } } } }]);
});

test("updateChannelBrandingChannel sends part=brandingSettings with only brandingSettings.channel as given", async () => {
  const calls: unknown[] = [];
  await updateChannelBrandingChannel({ youtube: fakeChannelsClient(calls), channelId: "UC1", channel: { description: "D", defaultLanguage: "en" } });
  assert.deepEqual(calls, [{ part: ["brandingSettings"], requestBody: { id: "UC1", brandingSettings: { channel: { description: "D", defaultLanguage: "en" } } } }]);
});

test("pickSettableBrandingChannelFields keeps the six settable fields with a value, drops the title and anything else", () => {
  const read = {
    title: "Base",
    description: "Base desc",
    keywords: "music \"lo fi\"",
    country: "JP",
    unsubscribedTrailer: "abcdefghijk",
    trackingAnalyticsAccountId: "UA-1",
    defaultLanguage: null,
    showRelatedChannels: true,
    moderateComments: false,
  };
  assert.deepEqual(pickSettableBrandingChannelFields(read), {
    description: "Base desc",
    keywords: "music \"lo fi\"",
    country: "JP",
    unsubscribedTrailer: "abcdefghijk",
    trackingAnalyticsAccountId: "UA-1",
  });
});
