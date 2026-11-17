import { createHash } from "node:crypto";

/**
 * BL-270 (owner TG 4662/4665) and its review (finding 2): the cheap fingerprint the plan progress's package-scan cache keys on.
 * Pure over its ports; `publishing/index.ts` wires the real ones.
 *
 * - `signature` is read BEFORE a scan: every file under the channel's `04 Videos/` (path, size, modification time, to the walk's
 *   depth), the removed-on-YouTube list, when the copy was last synced or checked, and the fields of the channel's videos rows the
 *   scan reads -- so a local-copy write by any module (finding 2: `video-details`' veto, plan date, Producer move, package metadata)
 *   moves it, not only a channel sync.
 */
export type ScanSignatureDeps = {
  workspace(channelId: string): Promise<string | null>;
  folderSignature(workspace: string): Promise<string>;
  removedVideos(channelId: string): Promise<unknown>;
  channelTimes(channelId: string): Promise<{ lastSyncedAt: number | null; removedCheckAt: number | null } | null>;
  videos(channelId: string): Promise<unknown[]>;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function createPackageScanSignature(deps: ScanSignatureDeps) {
  return {
    async signature(channelId: string): Promise<string | null> {
      try {
        const workspace = await deps.workspace(channelId);
        if (!workspace) return null;
        const [folder, removed, channel, videos] = await Promise.all([
          deps.folderSignature(workspace),
          deps.removedVideos(channelId),
          deps.channelTimes(channelId),
          deps.videos(channelId),
        ]);
        return JSON.stringify([workspace, sha256(folder), removed, channel?.lastSyncedAt ?? null, channel?.removedCheckAt ?? null, sha256(JSON.stringify(videos))]);
      } catch {
        return null;
      }
    },
  };
}
