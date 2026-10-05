import assert from "node:assert/strict";
import test from "node:test";
import { describeNicheEvidence, groupCandidatesByTopic, NICHE_MIN_GROUP_SIZE } from "./niche-discovery";

test("AC-9F-01: two discovery candidates sharing a topic form a niche group", () => {
  const groups = groupCandidatesByTopic(
    [
      { channelId: "UCa", title: "Channel A" },
      { channelId: "UCb", title: "Channel B" },
    ],
    [
      { topicId: "topic-jazz", subjectType: "channel", subjectId: "UCa" },
      { topicId: "topic-jazz", subjectType: "channel", subjectId: "UCb" },
    ],
    [],
    new Map()
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].topicId, "topic-jazz");
  assert.deepEqual(
    groups[0].discoveryCandidates.map((c) => c.channelId),
    ["UCa", "UCb"]
  );
});

test("AC-9F-02: a topic with exactly 1 member (below NICHE_MIN_GROUP_SIZE) is NOT reported as a niche", () => {
  assert.equal(NICHE_MIN_GROUP_SIZE, 2);
  const groups = groupCandidatesByTopic(
    [{ channelId: "UCa", title: "Channel A" }],
    [{ topicId: "topic-lonely", subjectType: "channel", subjectId: "UCa" }],
    [],
    new Map()
  );
  assert.deepEqual(groups, []);
});

test("AC-9F-03: zero shared-topic members produces an empty result, no crash", () => {
  const groups = groupCandidatesByTopic([], [], [], new Map());
  assert.deepEqual(groups, []);
});

test("AC-9F-04: a discovery candidate and a trend candidate sharing a topic combine into one group", () => {
  const groups = groupCandidatesByTopic(
    [{ channelId: "UCa", title: "Channel A" }],
    [{ topicId: "topic-jazz", subjectType: "channel", subjectId: "UCa" }],
    [{ trendCandidateId: "tc-1", title: "Lo-fi jazz resurgence", hasEvidence: true }],
    new Map([["tc-1", "topic-jazz"]])
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].discoveryCandidates.length, 1);
  assert.equal(groups[0].trendCandidates.length, 1);
});

test("AC-9F-05: describeNicheEvidence reports the specific 'no trend evidence' unknown for a discovery-only group, never a generic 'no data'", () => {
  const evidence = describeNicheEvidence({
    topicId: "topic-jazz",
    discoveryCandidates: [
      { channelId: "UCa", title: "Channel A" },
      { channelId: "UCb", title: "Channel B" },
    ],
    trendCandidates: [],
  });
  assert.deepEqual(evidence.representativeChannelIds, ["UCa", "UCb"]);
  assert.deepEqual(evidence.representativeTrendCandidateIds, []);
  assert.equal(evidence.unknowns.length, 1);
  assert.match(evidence.unknowns[0], /no trend evidence beyond initial discovery/);
});

test("AC-9F-05b: describeNicheEvidence reports the 'none has evidence' unknown when trend candidates exist but all lack evidence", () => {
  const evidence = describeNicheEvidence({
    topicId: "topic-jazz",
    discoveryCandidates: [{ channelId: "UCa", title: "Channel A" }],
    trendCandidates: [{ trendCandidateId: "tc-1", title: "x", hasEvidence: false }],
  });
  assert.deepEqual(evidence.unknowns, ["trend candidates share this topic, but none has any recorded evidence yet"]);
});

test("AC-9F-05c: describeNicheEvidence on an empty group (neither kind of member) reports one honest unknown, never two contradictory claims", () => {
  const evidence = describeNicheEvidence({ topicId: "t", discoveryCandidates: [], trendCandidates: [] });
  assert.equal(evidence.unknowns.length, 1);
});

test("AC-9F-06: describeNicheEvidence reports zero unknowns when both discovery and evidenced trend candidates are present", () => {
  const evidence = describeNicheEvidence({
    topicId: "topic-jazz",
    discoveryCandidates: [{ channelId: "UCa", title: "Channel A" }],
    trendCandidates: [{ trendCandidateId: "tc-1", title: "Lo-fi jazz resurgence", hasEvidence: true }],
  });
  assert.deepEqual(evidence.unknowns, []);
});
