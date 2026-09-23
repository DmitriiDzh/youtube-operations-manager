import { setStoredEditorialProfileRow } from "@/lib/db";
import type { EditorialProfileDocument } from "../contracts";

/**
 * SQL read-projection, mirroring `change-drafts/adapters/sql-projection.ts`'s pattern: writes
 * the Automerge document's current state into the existing `channel_editorial_profiles` table
 * via a raw overwrite (`setStoredEditorialProfileRow`), never a second SQLite connection.
 */
export type SqlProjectionAdapter = {
  upsertProfile(profile: EditorialProfileDocument): Promise<void>;
};

export function createSqlProjectionAdapter(): SqlProjectionAdapter {
  return {
    async upsertProfile(profile: EditorialProfileDocument): Promise<void> {
      await setStoredEditorialProfileRow({
        channelId: profile.channelId,
        version: profile.version,
        targetAudience: profile.targetAudience,
        toneNotes: profile.toneNotes,
        terminologyNotes: profile.terminologyNotes,
        titleConstraints: profile.titleConstraints,
        descriptionConstraints: profile.descriptionConstraints,
        updatedAt: new Date(profile.updatedAt),
      });
    },
  };
}
