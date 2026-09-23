import { getStoredEditorialProfile } from "@/lib/db";
import type { EditorialProfileDocument } from "../contracts";

/**
 * Read-only access to whatever this channel's editorial profile looked like in SQL BEFORE this
 * module owned writes -- used only to bootstrap a channel's very first Automerge document from
 * pre-existing data (mirrors `change-drafts/adapters/sql-source.ts`'s identical CD4 role, but
 * applied lazily on first write here rather than as a separate one-time migration call, since
 * this document has no map of many entities to migrate -- just one row).
 */
export type SqlSourceAdapter = {
  getExistingProfile(channelId: string): Promise<EditorialProfileDocument | null>;
};

export function createSqlSourceAdapter(): SqlSourceAdapter {
  return {
    async getExistingProfile(channelId: string): Promise<EditorialProfileDocument | null> {
      const row = await getStoredEditorialProfile(channelId);
      if (!row) return null;
      return {
        channelId: row.channelId,
        version: row.version,
        targetAudience: row.targetAudience,
        toneNotes: row.toneNotes,
        terminologyNotes: row.terminologyNotes,
        titleConstraints: row.titleConstraints,
        descriptionConstraints: row.descriptionConstraints,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  };
}
