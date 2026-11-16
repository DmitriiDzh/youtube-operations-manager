import { createReleaseFolderRenameCore, type ReleaseFolderRenameInput, type ReleaseFolderRenameResult } from "@/lib/publishing";
import { invalidatePlanPackages } from "@/lib/publishing-plan-progress";

// BL-261 (owner TG 3521 via the Factory Operator): the release-folder rename as the factory tool reaches it -- only this one
// operation of the publishing module (no upload, no YouTube writer), with the weekly plan's package cache read again after it.
export async function renameReleaseFolder(input: ReleaseFolderRenameInput): Promise<ReleaseFolderRenameResult> {
  return createReleaseFolderRenameCore({ invalidate: (channelId) => invalidatePlanPackages(channelId) }).rename(input);
}
