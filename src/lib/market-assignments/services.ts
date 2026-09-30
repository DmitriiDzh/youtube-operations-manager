import { DomainError } from "./contracts";
import type { MarketAssignmentView, MarketRecordKind } from "./contracts";
import { listMarketAssignmentsInputSchema, parseWithSchema, setMarketAssignmentInputSchema } from "./schemas";

export type MarketAssignmentStore = {
  listAssignedRecordIds(channelId: string, recordKind: MarketRecordKind): Promise<string[]>;
  listByKind(recordKind: MarketRecordKind): Promise<Array<{ channelId: string; recordId: string }>>;
  setChannels(recordKind: MarketRecordKind, recordId: string, channelIds: string[]): Promise<void>;
  add(channelId: string, recordKind: MarketRecordKind, recordId: string): Promise<void>;
};

export type ServiceDependencies = {
  store: MarketAssignmentStore;
  /** The bound channel of this process's agent session, or null for the operator. */
  getAgentBoundChannelId(): string | null;
  listConnectedChannelIds(): Promise<string[]>;
  /** Whether the referenced Phase 9 record exists (operator assignment validation). */
  recordExists(recordKind: MarketRecordKind, recordId: string): Promise<boolean>;
};

/** Error for a record an agent may not see -- deliberately the SAME code market-intelligence uses for a
 * nonexistent research channel, so an agent cannot tell "not assigned to you" from "does not exist". */
function notAvailable(recordKind: MarketRecordKind, recordId: string) {
  return new DomainError({
    code: "RESEARCH_CHANNEL_NOT_AVAILABLE",
    message: "market record not available",
    details: { recordKind, recordId },
  });
}

export function createMarketAssignmentServices(deps: ServiceDependencies) {
  return {
    /**
     * Agent confinement (AC-P12-09). Outside an agent session: `items` unchanged (operator sees all).
     * Inside one: only items assigned to the bound channel.
     */
    async filterForAgent<T>(recordKind: MarketRecordKind, items: T[], idOf: (item: T) => string): Promise<T[]> {
      const boundChannelId = deps.getAgentBoundChannelId();
      if (!boundChannelId) return items;
      const assigned = new Set(await deps.store.listAssignedRecordIds(boundChannelId, recordKind));
      return items.filter((item) => assigned.has(idOf(item)));
    },

    /** Agent confinement for a single record; no-op for the operator. */
    async assertAvailableToAgent(recordKind: MarketRecordKind, recordId: string): Promise<void> {
      const boundChannelId = deps.getAgentBoundChannelId();
      if (!boundChannelId) return;
      const assigned = await deps.store.listAssignedRecordIds(boundChannelId, recordKind);
      if (!assigned.includes(recordId)) throw notAvailable(recordKind, recordId);
    },

    /** Records a newly created record (e.g. an agent's research request) as owned by the agent's
     * channel. No-op for the operator (an operator-created record starts unassigned). */
    async recordAgentOwnership(recordKind: MarketRecordKind, recordId: string): Promise<void> {
      const boundChannelId = deps.getAgentBoundChannelId();
      if (!boundChannelId) return;
      await deps.store.add(boundChannelId, recordKind, recordId);
    },

    /** Operator-only: every assignment of one kind, grouped by record. */
    async listAssignments(input: unknown): Promise<MarketAssignmentView[]> {
      const { recordKind } = parseWithSchema(listMarketAssignmentsInputSchema, input, "list market assignments input");
      const rows = await deps.store.listByKind(recordKind);
      const byRecord = new Map<string, string[]>();
      for (const row of rows) byRecord.set(row.recordId, [...(byRecord.get(row.recordId) ?? []), row.channelId]);
      return [...byRecord.entries()].map(([recordId, channelIds]) => ({ recordKind, recordId, channelIds: channelIds.sort() }));
    },

    /**
     * Operator-only: replaces the full set of channels a record is assigned to. Every channel must be
     * connected and the record must exist; nothing is written otherwise. Never reachable from an
     * agent session (the agent's own channel is fixed; it cannot hand itself more data).
     */
    async setAssignment(input: unknown): Promise<MarketAssignmentView> {
      if (deps.getAgentBoundChannelId()) {
        throw new DomainError({ code: "AGENT_SESSION_OPERATOR_ONLY", message: "assigning market records is operator-only" });
      }
      const parsed = parseWithSchema(setMarketAssignmentInputSchema, input, "set market assignment input");
      const channelIds = [...new Set(parsed.channelIds)].sort();
      const connected = new Set(await deps.listConnectedChannelIds());
      const unknown = channelIds.filter((channelId) => !connected.has(channelId));
      if (unknown.length > 0) {
        throw new DomainError({
          code: "validation_failed",
          message: "every channelId must be one of this installation's connected channels",
          details: { unknownChannelIds: unknown },
        });
      }
      if (!(await deps.recordExists(parsed.recordKind, parsed.recordId))) {
        throw notAvailable(parsed.recordKind, parsed.recordId);
      }
      await deps.store.setChannels(parsed.recordKind, parsed.recordId, channelIds);
      return { recordKind: parsed.recordKind, recordId: parsed.recordId, channelIds };
    },
  };
}

export type MarketAssignmentServices = ReturnType<typeof createMarketAssignmentServices>;
