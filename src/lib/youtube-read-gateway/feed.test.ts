import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChannelFeed } from "./feed";

// The feed format: YouTube's public Atom feed (fields confirmed by a live fetch during the Phase 13
// research, docs/roadmap/plans/PHASE_13_SOURCES_RESEARCH.md §1).
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Some Channel</title>
 <entry>
  <id>yt:video:abcDEF12345</id>
  <yt:videoId>abcDEF12345</yt:videoId>
  <yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId>
  <title>Rain &amp; Jazz &#39;Night&#39;</title>
  <published>2026-09-30T10:00:00+00:00</published>
  <media:group>
   <media:community>
    <media:starRating count="42" average="5.00" min="1" max="5"/>
    <media:statistics views="1234"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>noStats0001</yt:videoId>
  <title>No stats</title>
 </entry>
 <entry><title>no id -- skipped</title></entry>
</feed>`;

test("13.5: the feed parser reads id, title (entities decoded), publish time, views and likes", () => {
  const videos = parseChannelFeed(SAMPLE);
  assert.deepEqual(videos[0], {
    videoId: "abcDEF12345",
    title: "Rain & Jazz 'Night'",
    publishedAt: "2026-09-30T10:00:00+00:00",
    viewCount: 1234,
    likeCount: 42,
  });
});

test("13.5: missing statistics stay null, never 0; an entry without a video id is skipped", () => {
  const videos = parseChannelFeed(SAMPLE);
  assert.equal(videos.length, 2);
  assert.deepEqual(videos[1], { videoId: "noStats0001", title: "No stats", publishedAt: null, viewCount: null, likeCount: null });
});
