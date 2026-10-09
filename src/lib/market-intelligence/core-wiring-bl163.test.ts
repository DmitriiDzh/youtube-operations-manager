import assert from "node:assert/strict";
import test from "node:test";
import { getResearchChannelById, insertMarketVideoSnapshot, insertResearchChannel, listAgentProposals } from "@/lib/db";
import { createMarketIntelligenceCore } from "./index";

// BL-163 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.A): the real core, on this test process's isolated database,
// has the newest-upload read, the inactivity setting and the pause wired in (the service tests inject them; a missing wire made
// every one of them a silent no-op or an error in the app). Expected values are stated by hand.

const ENTRY = "UCwwwwwwwwwwwwwwwwwwwwww";
const MONTH = 30 * 24 * 60 * 60 * 1000;

test("core wiring: the setting persists, the newest upload is read, the detector pauses with a proposal, the owner resumes", async () => {
  const core = createMarketIntelligenceCore();
  assert.deepEqual(await core.getInactivitySetting(), { inactiveAfterMonths: 6 });
  assert.deepEqual(await core.setInactivitySetting({ inactiveAfterMonths: 7 }), { inactiveAfterMonths: 7 });
  assert.deepEqual(await core.getInactivitySetting(), { inactiveAfterMonths: 7 });

  await insertResearchChannel({ id: ENTRY, handleOrUrl: "@quiet", reason: "competitor", createdVia: "web_ui" });
  const newest = new Date(Math.floor((Date.now() - 9 * MONTH) / 1000) * 1000); // 9 months > 7: inactive (stored in whole seconds)
  await insertMarketVideoSnapshot({ id: "bl163-wiring-1", researchChannelId: ENTRY, videoId: "v1", publishedAt: newest, source: "youtube.videos.list", createdVia: "web_ui" });
  const entry = (await core.listWatchlist()).channels.find((c) => c.channelId === ENTRY)!;
  assert.deepEqual([entry.latestUploadPublishedAt, entry.inactive, entry.pausedAt], [newest.toISOString(), true, null]);

  assert.deepEqual(await core.evaluateWatchlistInactivity(), { paused: [ENTRY] });
  assert.equal((await getResearchChannelById(ENTRY))?.pausedReason, "inactive");
  const proposals = (await listAgentProposals({ status: "pending" })).filter((p) => p.targetId === ENTRY);
  assert.deepEqual(proposals.map((p) => [p.source, p.kind]), [["system", "watchlist.delete"]]);

  const resumed = await core.setWatchlistPause({ channelId: ENTRY, paused: false });
  assert.deepEqual([resumed.pausedAt, resumed.pausedReason], [null, null]);
  assert.deepEqual(await core.evaluateWatchlistInactivity(), { paused: [] }, "not paused again for the same silence");
  const paused = await core.setWatchlistPause({ channelId: ENTRY, paused: true });
  assert.equal(paused.pausedReason, "owner");
});
