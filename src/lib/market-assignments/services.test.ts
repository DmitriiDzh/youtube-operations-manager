import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "./contracts";
import type { MarketRecordKind } from "./contracts";
import { createMarketAssignmentServices, type MarketAssignmentStore } from "./services";

// docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-09 and owner decision D1 ("shared collection, then give
// each channel what it needs"): the operator sees everything and assigns; an agent sees only its
// channel's assignments; an agent cannot assign.

function createStore() {
  const rows: Array<{ channelId: string; recordKind: MarketRecordKind; recordId: string }> = [];
  const store: MarketAssignmentStore = {
    async listAssignedRecordIds(channelId, recordKind) {
      return rows.filter((r) => r.channelId === channelId && r.recordKind === recordKind).map((r) => r.recordId);
    },
    async listByKind(recordKind) {
      return rows.filter((r) => r.recordKind === recordKind).map(({ channelId, recordId }) => ({ channelId, recordId }));
    },
    async setChannels(recordKind, recordId, channelIds) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].recordKind === recordKind && rows[i].recordId === recordId) rows.splice(i, 1);
      for (const channelId of channelIds) rows.push({ channelId, recordKind, recordId });
    },
    async add(channelId, recordKind, recordId) {
      if (!rows.some((r) => r.channelId === channelId && r.recordKind === recordKind && r.recordId === recordId)) {
        rows.push({ channelId, recordKind, recordId });
      }
    },
  };
  return { store, rows };
}

function createServices(boundChannelId: string | null, shared = createStore()) {
  const services = createMarketAssignmentServices({
    store: shared.store,
    getAgentBoundChannelId: () => boundChannelId,
    listConnectedChannelIds: async () => ["UC_A", "UC_B"],
    recordExists: async (kind, id) => kind === "research_channel" && ["UCcompetitorX", "UCcompetitorY"].includes(id),
  });
  return { services, shared };
}

const isCode = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;

test("operator assigns a shared competitor to both channels; each agent sees only its own assignments", async () => {
  const operator = createServices(null);
  await operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: ["UC_B", "UC_A", "UC_A"] });
  await operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorY", channelIds: ["UC_B"] });

  const all = [{ id: "UCcompetitorX" }, { id: "UCcompetitorY" }, { id: "UCunassigned" }];
  assert.deepEqual(await operator.services.filterForAgent("research_channel", all, (x) => x.id), all);

  const agentA = createServices("UC_A", operator.shared);
  const agentB = createServices("UC_B", operator.shared);
  assert.deepEqual((await agentA.services.filterForAgent("research_channel", all, (x) => x.id)).map((x) => x.id), ["UCcompetitorX"]);
  assert.deepEqual((await agentB.services.filterForAgent("research_channel", all, (x) => x.id)).map((x) => x.id), ["UCcompetitorX", "UCcompetitorY"]);

  await agentA.services.assertAvailableToAgent("research_channel", "UCcompetitorX");
  await assert.rejects(agentA.services.assertAvailableToAgent("research_channel", "UCcompetitorY"), isCode("RESEARCH_CHANNEL_NOT_AVAILABLE"));
  await assert.rejects(agentA.services.assertAvailableToAgent("topic", "UCcompetitorX"), isCode("RESEARCH_CHANNEL_NOT_AVAILABLE"));

  assert.deepEqual(await operator.services.listAssignments({ recordKind: "research_channel" }), [
    { recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: ["UC_A", "UC_B"] },
    { recordKind: "research_channel", recordId: "UCcompetitorY", channelIds: ["UC_B"] },
  ]);
});

test("setAssignment replaces the set, validates channels and record, and is refused in an agent session", async () => {
  const operator = createServices(null);
  await operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: ["UC_A"] });
  await operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: [] });
  assert.deepEqual(operator.shared.rows, []);

  await assert.rejects(
    operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: ["UC_NOT_CONNECTED"] }),
    isCode("validation_failed")
  );
  await assert.rejects(
    operator.services.setAssignment({ recordKind: "research_channel", recordId: "UCnope", channelIds: ["UC_A"] }),
    isCode("RESEARCH_CHANNEL_NOT_AVAILABLE")
  );
  const agent = createServices("UC_A", operator.shared);
  await assert.rejects(
    agent.services.setAssignment({ recordKind: "research_channel", recordId: "UCcompetitorX", channelIds: ["UC_A"] }),
    isCode("AGENT_SESSION_OPERATOR_ONLY")
  );
  assert.deepEqual(operator.shared.rows, []);
});

test("recordAgentOwnership assigns an agent-created record to the agent's channel only; no-op for the operator", async () => {
  const operator = createServices(null);
  await operator.services.recordAgentOwnership("research_request", "req-op");
  assert.deepEqual(operator.shared.rows, []);

  const agent = createServices("UC_A", operator.shared);
  await agent.services.recordAgentOwnership("research_request", "req-1");
  assert.deepEqual(operator.shared.rows, [{ channelId: "UC_A", recordKind: "research_request", recordId: "req-1" }]);
});
