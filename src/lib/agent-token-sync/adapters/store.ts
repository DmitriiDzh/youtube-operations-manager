import { applyAgentTokenSyncPlan, listAgentTokenRowsForSync } from "@/lib/db";
import type { AgentTokenSyncDeps } from "../services";

/** The three token tables through `db.ts` (hash, purpose, dates; never a token). */
export function createAgentTokenSyncStore(): AgentTokenSyncDeps["store"] {
  return {
    async listAll() {
      return (await listAgentTokenRowsForSync()).map((row) => ({
        hash: row.tokenHash,
        role: row.role,
        channelId: row.channelId,
        userId: row.userId,
        label: row.label,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt,
      }));
    },
    async apply(plan) {
      await applyAgentTokenSyncPlan({
        revoke: plan.revoke.map((item) => ({ role: item.role, tokenHash: item.hash, revokedAt: item.revokedAt })),
        insert: plan.insert.map((record) => ({
          id: record.id,
          role: record.role,
          tokenHash: record.hash,
          channelId: record.channelId,
          userId: record.userId,
          label: record.label,
          createdAt: record.createdAt,
          revokedAt: record.revokedAt,
        })),
        redate: plan.redate.map((item) => ({ role: item.role, tokenHash: item.hash, createdAt: item.createdAt })),
      });
    },
  };
}
