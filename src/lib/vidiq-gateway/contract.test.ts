import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { checkStaticCall, parseStatedCost, pinnedCostFor, VIDIQ_ALLOWED_TOOLS, VIDIQ_TOOL_TTL_SECONDS } from "./contract";

// BL-278 stage 1 (VIDIQ_INTEGRATION_PLAN.md §4, ADR 0077 decision 4). Expected values are written by hand from the plan's §4 table,
// which was checked against fixtures/tools-list.2026-11-26.json -- never derived from contract.ts itself.

const EXPECTED_COSTS: Record<string, number> = {
  vidiq_keyword_research: 5,
  vidiq_channel_search: 5,
  vidiq_outliers: 5,
  vidiq_trend_categories: 0,
  vidiq_trending_videos: 5,
  vidiq_similar_channels: 5,
  vidiq_channel_stats: 5,
  vidiq_channel_performance_trends: 5,
  vidiq_channel_videos: 5,
  vidiq_get_channels_by_ids: 5,
  vidiq_get_videos_by_ids: 5,
  vidiq_video_stats: 5,
  vidiq_video_change_history: 5,
  vidiq_title_thumbnail_wins: 5,
  vidiq_video_earnings_estimate: 5,
  vidiq_balance: 0,
  vidiq_job_poll: 0,
};
const H = 3600;
const D = 24 * H;
const EXPECTED_TTL: Record<string, number | null> = {
  vidiq_keyword_research: D,
  vidiq_channel_search: D,
  vidiq_outliers: D,
  vidiq_trend_categories: 7 * D,
  vidiq_trending_videos: D,
  vidiq_similar_channels: 7 * D,
  vidiq_channel_stats: 7 * D,
  vidiq_channel_performance_trends: 7 * D,
  vidiq_channel_videos: 7 * D,
  vidiq_get_channels_by_ids: 7 * D,
  vidiq_get_videos_by_ids: 7 * D,
  vidiq_video_stats: 7 * D,
  vidiq_video_change_history: 7 * D,
  vidiq_title_thumbnail_wins: D,
  vidiq_comment_insights: D,
  vidiq_video_earnings_estimate: 7 * D,
  vidiq_balance: null,
  vidiq_job_poll: null,
};

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`;
  }
}

test("the allowlist is exactly the 18 tools of plan §4, with the owner's earnings tool kept (TG 4961, Q1)", () => {
  assert.deepEqual([...VIDIQ_ALLOWED_TOOLS].sort(), [...Object.keys(EXPECTED_COSTS), "vidiq_comment_insights"].sort());
  assert.equal(VIDIQ_ALLOWED_TOOLS.length, 18);
});

test("pinned costs and TTLs match plan §4; comment_insights is 5 per discover/validate/new raw and 0 for a raw cursor page", () => {
  for (const [tool, cost] of Object.entries(EXPECTED_COSTS)) assert.equal(pinnedCostFor(tool, {}), cost, tool);
  assert.equal(pinnedCostFor("vidiq_comment_insights", { mode: "discover" }), 5);
  assert.equal(pinnedCostFor("vidiq_comment_insights", { mode: "validate", idea: "x" }), 5);
  assert.equal(pinnedCostFor("vidiq_comment_insights", { mode: "raw", niche: "x" }), 5);
  assert.equal(pinnedCostFor("vidiq_comment_insights", { mode: "raw", cursor: "a".repeat(64) }), 0);
  for (const [tool, ttl] of Object.entries(EXPECTED_TTL)) assert.equal(VIDIQ_TOOL_TTL_SECONDS[tool as keyof typeof VIDIQ_TOOL_TTL_SECONDS], ttl, tool);
});

test("the Cost sentence parses to its number; anything else is unreadable (null)", () => {
  assert.equal(parseStatedCost("vidiq_keyword_research", "Find keywords.\n\nCost: 5 credit(s) per call."), 5);
  assert.equal(parseStatedCost("vidiq_balance", "Balance.\n\nCost: 0 credit(s) per call."), 0);
  assert.equal(parseStatedCost("vidiq_keyword_research", "Find keywords.\n\nCost: 10 credit(s) per call."), 10);
  assert.equal(parseStatedCost("vidiq_keyword_research", "Find keywords."), null);
  assert.equal(parseStatedCost("vidiq_keyword_research", "Cost: five credits per call."), null);
  assert.equal(parseStatedCost("vidiq_comment_insights", "x\n\nCost: 5 credits per discover, validate, or new raw search. Raw cursor pages are free."), 5);
  assert.equal(parseStatedCost("vidiq_comment_insights", "x\n\nCost: 10 credits per discover, validate, or new raw search. Raw cursor pages are free."), 10);
  assert.equal(parseStatedCost("vidiq_comment_insights", "x\n\nCost: 5 credit(s) per call."), null);
});

test("AC-VQ-1.5: a tool not on the list is refused before anything else", () => {
  for (const tool of ["vidiq_coach_message_create", "vidiq_update_competitors", "vidiq_generate_titles", "vidiq_invented_tool", "", "list_competitors"]) {
    assert.equal(codeOf(() => checkStaticCall(tool, {})), "vidiq_tool_not_allowed", tool);
  }
});

test("AC-VQ-1.7 (pinned half): arguments failing the pinned schema or carrying an unknown property are vidiq_args_invalid", () => {
  assert.equal(codeOf(() => checkStaticCall("vidiq_similar_channels", { size: "ten" })), "vidiq_args_invalid");
  assert.equal(codeOf(() => checkStaticCall("vidiq_similar_channels", { niche: "cooking", region: "US" })), "vidiq_args_invalid");
  assert.equal(codeOf(() => checkStaticCall("vidiq_channel_stats", {})), "vidiq_args_invalid"); // channelId is required
  assert.equal(codeOf(() => checkStaticCall("vidiq_similar_channels", "not an object")), "vidiq_args_invalid");
  assert.equal(codeOf(() => checkStaticCall("vidiq_similar_channels", { niche: "cooking", size: 10 })), null);
});

test("AC-VQ-1.15: a handle or URL where a channel or video id belongs is vidiq_canonical_id_required; canonical ids pass", () => {
  const uc = "UC" + "a".repeat(22);
  for (const args of [
    ["vidiq_channel_stats", { channelId: "@somechannel" }],
    ["vidiq_channel_stats", { channelId: "https://www.youtube.com/@somechannel" }],
    ["vidiq_get_channels_by_ids", { channelIds: [uc, "@other"] }],
    ["vidiq_similar_channels", { niche: "x", excludeChannelIds: ["youtube.com/channel/x"] }],
    ["vidiq_video_change_history", { videoId: "https://youtu.be/abcdefghijk" }],
    ["vidiq_get_videos_by_ids", { videoIds: ["abcdefghijk", "short"] }],
    ["vidiq_outliers", { seedVideoId: "toolong_abcdefg" }],
  ] as const) {
    assert.equal(codeOf(() => checkStaticCall(args[0], args[1])), "vidiq_canonical_id_required", JSON.stringify(args));
  }
  assert.equal(codeOf(() => checkStaticCall("vidiq_channel_stats", { channelId: uc })), null);
  assert.equal(codeOf(() => checkStaticCall("vidiq_get_videos_by_ids", { videoIds: ["abcdefghijk", "A-_bcdefghi"] })), null);
});

test("AC-VQ-1.15: userGoal is stripped from the arguments that would be sent", () => {
  const checked = checkStaticCall("vidiq_similar_channels", { niche: "cooking", userGoal: "grow my channel about the owner's secret plan" });
  assert.deepEqual(checked.args, { niche: "cooking" });
  assert.equal(checked.tool, "vidiq_similar_channels");
  assert.equal(checked.pinnedCost, 5);
});

test("job_poll takes a non-empty string mcpJobId only (the ledger check belongs to vidiq-research)", () => {
  assert.equal(codeOf(() => checkStaticCall("vidiq_job_poll", { mcpJobId: "" })), "vidiq_args_invalid");
  assert.equal(codeOf(() => checkStaticCall("vidiq_job_poll", {})), "vidiq_args_invalid");
  assert.equal(codeOf(() => checkStaticCall("vidiq_job_poll", { mcpJobId: "job-1" })), null);
});
