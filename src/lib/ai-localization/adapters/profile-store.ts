import { getGenerationProvenanceByChangeSetId, getStoredEditorialProfile } from "@/lib/db";
import { createChangeDraftsCoreForProduction, createEditorialProfileCoreForProduction } from "@/lib/sync-gateway";

/**
 * Cutover, 2026-09-22 (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3, mirrors
 * `changesets/adapters/change-drafts-store.ts`'s own CD2 cutover pattern exactly): writes now go
 * through `src/lib/sync-gateway/editorial-profile/` (Automerge) instead of directly to SQL --
 * this is the single place that changes. `services.ts` itself, and every route/MCP/CLI caller,
 * is unaffected -- they only ever depended on this adapter's interface, unchanged in shape.
 * Reads stay pointed directly at the existing SQL function: the Automerge module re-projects
 * `channel_editorial_profiles` after every successful write, so a read has no reason to go
 * through Automerge at all (same reasoning as the change-drafts cutover).
 */
export function createEditorialProfileStoreAdapter() {
  const core = createEditorialProfileCoreForProduction();

  return {
    getProfile: getStoredEditorialProfile,
    async saveProfile(input: {
      channelId: string;
      targetAudience?: string | null;
      toneNotes?: string | null;
      terminologyNotes?: string | null;
      titleConstraints?: string | null;
      descriptionConstraints?: string | null;
    }) {
      const saved = await core.saveProfile(input);
      return { ...saved, updatedAt: new Date(saved.updatedAt) };
    },
  };
}

/**
 * Cutover, 2026-09-22 (M4): provenance is now created through `src/lib/sync-gateway/change-
 * drafts/` (the same per-channel Automerge document as its parent change set) instead of a
 * direct SQL insert. `getByChangeSetId` stays direct SQL, same reasoning as the editorial-profile
 * cutover above.
 */
export function createGenerationProvenanceStoreAdapter() {
  const core = createChangeDraftsCoreForProduction();

  return {
    async create(input: {
      id: string;
      changeSetId: string;
      channelId: string;
      profileVersion: number | null;
      effectiveContextJson: string | null;
      evidenceJson: string | null;
      rationale: string | null;
      createdVia: "mcp" | "cli" | "web_ui" | null;
      agentApiVersion: string | null;
    }): Promise<void> {
      await core.createProvenance(input);
    },
    getByChangeSetId: getGenerationProvenanceByChangeSetId,
  };
}
