import type { ZodType } from "zod";
import {
  AGENT_PROPOSAL_KEEP_DAYS,
  DomainError,
  isDomainError,
  type AgentProposal,
  type AgentProposalKind,
  type AgentProposalSource,
  type AgentProposalStatus,
  type OwnerAgentProposal,
} from "./contracts";
import {
  approveProposalInputSchema,
  listOwnerProposalsInputSchema,
  listProducerProposalsInputSchema,
  markProposalsDoneInputSchema,
  parseWithSchema,
  proposalPayloadSchemas,
  rejectProposalInputSchema,
  submitProducerProposalInputSchema,
} from "./schemas";

/** One stored proposal row (`agent_proposals`). */
export type StoredProposal = {
  id: string;
  source: AgentProposalSource;
  kind: string;
  channelId: string | null;
  targetId: string | null;
  payloadJson: string;
  text: string;
  status: AgentProposalStatus;
  dedupeKey: string | null;
  createdVia: string;
  agentApiVersion: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  rejectComment: string | null;
  applyError: string | null;
  doneAt: Date | null;
};

export type AgentProposalStore = {
  /** `created: false` = a pending proposal with the same dedupe key exists (returned), nothing written. */
  insert(row: Omit<StoredProposal, "status" | "decidedAt" | "decidedBy" | "rejectComment" | "applyError" | "doneAt">): Promise<{ proposal: StoredProposal; created: boolean }>;
  get(id: string): Promise<StoredProposal | null>;
  list(filter: { source?: AgentProposalSource; channelId?: string; status?: AgentProposalStatus; includeDone?: boolean }): Promise<StoredProposal[]>;
  /** Atomic: only a pending proposal moves; null otherwise. */
  decide(id: string, decision: { status: "applied" | "rejected"; at: Date; by: string; rejectComment?: string | null }): Promise<StoredProposal | null>;
  fail(id: string, error: string): Promise<void>;
  markDone(ids: string[], at: Date, filter: { source: AgentProposalSource }): Promise<string[]>;
  purge(now: Date, keepMs: number): Promise<number>;
};

/** The watchlist, through market-intelligence and market-assignments' own public cores (the same services the UI uses). */
export type WatchlistPort = {
  getEntry(researchChannelId: string): Promise<{ channelId: string; handleOrUrl: string | null; pausedAt: string | null } | null>;
  /** Our channels following the entry. */
  followers(researchChannelId: string): Promise<string[]>;
  add(input: { channelId: string; handleOrUrl?: string; reason: string }): Promise<void>;
  setFollowers(researchChannelId: string, channelIds: string[]): Promise<void>;
  setPause(researchChannelId: string, paused: boolean): Promise<void>;
  remove(researchChannelId: string): Promise<void>;
  labels(): Promise<Map<string, string>>;
};

export type HypothesesPort = {
  add(input: { channelId: string; statement: string; evidenceNotes: string }, ctx: { userId: string }): Promise<void>;
  /** The owner's active channel in the Web UI (a hypothesis is created there). */
  activeChannelOf(userId: string): Promise<string | null>;
};

export type AgentProposalDependencies = {
  idGenerator(): string;
  clock: { now(): Date };
  store: AgentProposalStore;
  watchlist: WatchlistPort;
  hypotheses: HypothesesPort;
  listConnectedChannels(): Promise<Array<{ channelId: string; title: string }>>;
  /** The app-wide pre-mutation gate (device handoff / recovery); throws when writing is not allowed. */
  assertDeviceAvailable(): Promise<void>;
};

const KEEP_MS = AGENT_PROPOSAL_KEEP_DAYS * 24 * 60 * 60 * 1000;

function parsePayload(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toProposal(row: StoredProposal): AgentProposal {
  return {
    proposalId: row.id,
    source: row.source,
    kind: row.kind,
    channelId: row.channelId,
    targetId: row.targetId,
    payload: parsePayload(row.payloadJson),
    text: row.text,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    rejectComment: row.rejectComment,
    applyError: row.applyError,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
  };
}

function notAvailable(researchChannelId: string): DomainError {
  // The same code market-intelligence uses, so "not followed by this channel" reads exactly like "not on the watchlist".
  return new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "No watchlist entry for the requested channel", details: { channelId: researchChannelId } });
}

function notApplicable(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "AGENT_PROPOSAL_NOT_APPLICABLE", message, details });
}

function errorMessage(error: unknown): string {
  if (isDomainError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function createAgentProposalServices(deps: AgentProposalDependencies) {
  /** Validates a Producer proposal against the current state and returns what to store about it. */
  async function checkSubmission(
    channelId: string,
    kind: AgentProposalKind,
    rawPayload: Record<string, unknown>
  ): Promise<{ payload: Record<string, unknown>; targetId: string | null; dedupeKey: string | null }> {
    const schema = proposalPayloadSchemas[kind] as unknown as ZodType<Record<string, unknown>>;
    const payload = parseWithSchema(schema, rawPayload, `${kind} payload`);
    if (kind === "hypothesis.add") return { payload, targetId: null, dedupeKey: null };
    if (kind === "watchlist.add") {
      const target = payload.competitorChannelId as string;
      if ((await deps.watchlist.getEntry(target)) && (await deps.watchlist.followers(target)).includes(channelId)) {
        throw notApplicable("This channel already follows that competitor", { channelId, competitorChannelId: target });
      }
      return { payload, targetId: target, dedupeKey: `${kind}|${target}|${channelId}` };
    }
    // The other kinds name an entry this channel follows (what its own agent can see).
    const target = payload.researchChannelId as string;
    const entry = await deps.watchlist.getEntry(target);
    if (!entry || !(await deps.watchlist.followers(target)).includes(channelId)) throw notAvailable(target);
    if (kind === "watchlist.pause" && entry.pausedAt) throw notApplicable("The entry is already paused", { researchChannelId: target });
    if (kind === "watchlist.resume" && !entry.pausedAt) throw notApplicable("The entry is not paused", { researchChannelId: target });
    // Unfollowing concerns one of our channels; pause, resume and delete change the entry for every channel, so one pending
    // proposal per entry (a delete shares its key with the system's own deletion proposal).
    return { payload, targetId: target, dedupeKey: kind === "watchlist.unfollow" ? `${kind}|${target}|${channelId}` : `${kind}|${target}` };
  }

  /** Makes the approved change, through the same services the UI uses. Throws when it cannot be made. */
  async function applyAgentProposal(row: StoredProposal, ctx: { userId: string }): Promise<void> {
    const payload = parsePayload(row.payloadJson);
    const target = row.targetId ?? "";
    switch (row.kind as AgentProposalKind) {
      case "watchlist.add": {
        const channelId = row.channelId!;
        const existing = await deps.watchlist.getEntry(target);
        if (!existing) {
          await deps.watchlist.add({
            channelId: target,
            ...(typeof payload.handleOrUrl === "string" ? { handleOrUrl: payload.handleOrUrl } : {}),
            reason: String(payload.reason ?? row.text),
          });
        }
        const followers = existing ? await deps.watchlist.followers(target) : [];
        await deps.watchlist.setFollowers(target, [...new Set([...followers, channelId])]);
        return;
      }
      case "watchlist.unfollow": {
        if (!(await deps.watchlist.getEntry(target))) throw notAvailable(target);
        const followers = await deps.watchlist.followers(target);
        await deps.watchlist.setFollowers(target, followers.filter((id) => id !== row.channelId));
        return;
      }
      case "watchlist.pause":
      case "watchlist.resume":
        if (!(await deps.watchlist.getEntry(target))) throw notAvailable(target);
        await deps.watchlist.setPause(target, row.kind === "watchlist.pause");
        return;
      case "watchlist.delete":
        if (!(await deps.watchlist.getEntry(target))) throw notAvailable(target);
        await deps.watchlist.remove(target);
        return;
      case "hypothesis.add":
        await deps.hypotheses.add(
          { channelId: row.channelId!, statement: String(payload.statement ?? ""), evidenceNotes: String(payload.evidenceNotes ?? "") },
          ctx
        );
        return;
      default:
        throw new DomainError({ code: "validation_failed", message: `Unknown proposal kind: ${row.kind}`, details: { kind: row.kind } });
    }
  }

  async function notFoundOrNotPending(proposalId: string): Promise<never> {
    const row = await deps.store.get(proposalId);
    if (!row) throw new DomainError({ code: "AGENT_PROPOSAL_NOT_FOUND", message: "No such proposal", details: { proposalId } });
    throw new DomainError({ code: "AGENT_PROPOSAL_NOT_PENDING", message: "This proposal has already been decided", details: { proposalId, status: row.status } });
  }

  return {
    /** Producer (AC-PR-01/04): stores one pending proposal; nothing else changes. */
    async submitProducerProposal(input: unknown, ctx: { agentApiVersion: string }): Promise<AgentProposal> {
      const parsed = parseWithSchema(submitProducerProposalInputSchema, input, "producer proposal input");
      await deps.assertDeviceAvailable();
      if (!(await deps.listConnectedChannels()).some((channel) => channel.channelId === parsed.channelId)) {
        throw new DomainError({
          code: "CHANNEL_NOT_ACTIVE",
          message: "This channel is not connected on this computer -- producer_list_channels lists the channels you can use.",
          details: { channelId: parsed.channelId },
        });
      }
      const checked = await checkSubmission(parsed.channelId, parsed.kind, parsed.payload);
      const stored = await deps.store.insert({
        id: deps.idGenerator(),
        source: "producer",
        kind: parsed.kind,
        channelId: parsed.channelId,
        targetId: checked.targetId,
        payloadJson: JSON.stringify(checked.payload),
        text: parsed.text,
        dedupeKey: checked.dedupeKey,
        createdVia: "mcp",
        agentApiVersion: ctx.agentApiVersion,
        createdAt: deps.clock.now(),
      });
      if (!stored.created) {
        throw new DomainError({
          code: "AGENT_PROPOSAL_DUPLICATE",
          message: "The same proposal is already waiting for the owner's decision",
          details: { proposalId: stored.proposal.id, source: stored.proposal.source },
        });
      }
      return toProposal(stored.proposal);
    },

    /** Producer (AC-PR-03): its own proposals, newest first, with the outcome and the owner's comment on a rejection. */
    async listProducerProposals(input: unknown): Promise<{ proposals: AgentProposal[] }> {
      const parsed = parseWithSchema(listProducerProposalsInputSchema, input, "list proposals input");
      await deps.store.purge(deps.clock.now(), KEEP_MS).catch(() => 0);
      const rows = await deps.store.list({ source: "producer", channelId: parsed.channelId, status: parsed.status, includeDone: parsed.includeDone ?? false });
      return { proposals: rows.map(toProposal) };
    },

    /** Producer (AC-PR-03): decided proposals it has read leave the store; a pending one is never touched. */
    async markProducerProposalsDone(input: unknown): Promise<{ marked: string[]; notMarked: string[] }> {
      const parsed = parseWithSchema(markProposalsDoneInputSchema, input, "mark proposals done input");
      await deps.assertDeviceAvailable();
      const ids = [...new Set(parsed.proposalIds)];
      const marked = await deps.store.markDone(ids, deps.clock.now(), { source: "producer" });
      await deps.store.purge(deps.clock.now(), KEEP_MS).catch(() => 0);
      return { marked, notMarked: ids.filter((id) => !marked.includes(id)) };
    },

    /** Owner (Web UI only): pending proposals, or the decided ones still in the store, with names for the ids. */
    async listOwnerProposals(input: unknown): Promise<{ proposals: OwnerAgentProposal[]; pendingCount: number }> {
      const parsed = parseWithSchema(listOwnerProposalsInputSchema, input, "list owner proposals input");
      await deps.store.purge(deps.clock.now(), KEEP_MS).catch(() => 0);
      const all = await deps.store.list({});
      const pending = all.filter((row) => row.status === "pending");
      const rows = parsed.view === "pending" ? pending : all.filter((row) => row.status !== "pending");
      const [labels, channels] = await Promise.all([deps.watchlist.labels().catch(() => new Map<string, string>()), deps.listConnectedChannels().catch(() => [])]);
      const titles = new Map(channels.map((channel) => [channel.channelId, channel.title]));
      return {
        pendingCount: pending.length,
        proposals: rows.map((row) => ({
          ...toProposal(row),
          channelTitle: row.channelId ? (titles.get(row.channelId) ?? null) : null,
          targetLabel: row.targetId ? (labels.get(row.targetId) ?? null) : null,
          decidedBy: row.decidedBy,
        })),
      };
    },

    /** Owner (Web UI only): the number the Research inbox badge counts. */
    async countPendingProposals(): Promise<number> {
      return (await deps.store.list({ status: "pending" })).length;
    },

    /**
     * Owner (Web UI only, AC-PR-02/07): one action. The proposal is claimed (`pending -> applied`, atomic) BEFORE the change is made:
     * a second approve gets NOT_PENDING and the change is made once, and deleting an entry (which drops its pending proposals) cannot
     * remove the very proposal being applied. A change that cannot be made leaves it `failed` with the error, never retried.
     */
    async approveAgentProposal(input: unknown, ctx: { userId: string }): Promise<OwnerAgentProposal> {
      const parsed = parseWithSchema(approveProposalInputSchema, input, "approve proposal input");
      await deps.assertDeviceAvailable();
      const row = await deps.store.get(parsed.proposalId);
      if (!row || row.status !== "pending") return notFoundOrNotPending(parsed.proposalId);
      if (row.kind === "hypothesis.add" && (await deps.hypotheses.activeChannelOf(ctx.userId)) !== row.channelId) {
        // Checked before the claim, so the proposal keeps waiting rather than failing.
        throw new DomainError({
          code: "AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE",
          message: "A hypothesis is added to the active channel: switch to the proposal's channel first",
          details: { proposalId: row.id, channelId: row.channelId },
        });
      }
      const claimed = await deps.store.decide(row.id, { status: "applied", at: deps.clock.now(), by: ctx.userId });
      if (!claimed) return notFoundOrNotPending(row.id);
      try {
        await applyAgentProposal(claimed, ctx);
      } catch (error) {
        await deps.store.fail(claimed.id, errorMessage(error));
      }
      const after = (await deps.store.get(claimed.id)) ?? claimed;
      return { ...toProposal(after), channelTitle: null, targetLabel: null, decidedBy: after.decidedBy };
    },

    /** Owner (Web UI only, AC-PR-02): a comment is required -- it is the Producer's only explanation. Nothing else changes. */
    async rejectAgentProposal(input: unknown, ctx: { userId: string }): Promise<OwnerAgentProposal> {
      const parsed = parseWithSchema(rejectProposalInputSchema, input, "reject proposal input");
      await deps.assertDeviceAvailable();
      const decided = await deps.store.decide(parsed.proposalId, { status: "rejected", at: deps.clock.now(), by: ctx.userId, rejectComment: parsed.comment });
      if (!decided) return notFoundOrNotPending(parsed.proposalId);
      return { ...toProposal(decided), channelTitle: null, targetLabel: null, decidedBy: decided.decidedBy };
    },
  };
}

export type AgentProposalServices = ReturnType<typeof createAgentProposalServices>;
