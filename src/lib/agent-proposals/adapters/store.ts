import {
  decideAgentProposal,
  failAgentProposal,
  getAgentProposal,
  insertAgentProposal,
  listAgentProposals,
  markAgentProposalsDone,
  purgeAgentProposals,
} from "@/lib/db";
import type { AgentProposalStore, StoredProposal } from "../services";

export function createAgentProposalStore(): AgentProposalStore {
  return {
    insert: async (row) => (await insertAgentProposal(row)) as { proposal: StoredProposal; created: boolean },
    get: async (id) => (await getAgentProposal(id)) as StoredProposal | null,
    list: async (filter) => (await listAgentProposals(filter)) as StoredProposal[],
    decide: async (id, decision) => (await decideAgentProposal(id, decision)) as StoredProposal | null,
    fail: (id, error) => failAgentProposal(id, error),
    markDone: (ids, at, filter) => markAgentProposalsDone(ids, at, filter),
    purge: (now, keepMs) => purgeAgentProposals(now, keepMs),
  };
}
