import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { DomainError } from "@/lib/shared-domain";
import { createExchangeFs, resolveFromYtmDir } from "@/lib/workspace-exchange";
import type { VoiceFilesPort } from "../services";

// BL-236: where a channel's voice previews live -- its workspace's `99 Data Exchange/From YTM/<provider>/voices/<voiceId>/` (the
// shared `workspace-exchange` rules, the same ones every job output uses). `getWorkspace` is injected (tests use a temp folder).

type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

export function createVoiceFiles(getWorkspace: WorkspaceLookup): VoiceFilesPort {
  return {
    async outputRoot(channelId) {
      const workspace = await getWorkspace(channelId);
      if (!workspace.configured) {
        throw new DomainError({ code: "voice_registry_unavailable", message: "This channel has no workspace folder on this computer (Settings → Channels); voice previews are kept only there.", details: { channelId } });
      }
      return resolveFromYtmDir({
        workspace: workspace.path,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new DomainError({ code: "voice_registry_unavailable", message: `The channel's workspace folder cannot keep voice previews: ${reason}`, details: { channelId, reason } }),
      });
    },
    async write(filePath, data) {
      await writeFileAtomic(filePath, data);
      return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    },
    join: (...parts) => path.join(...parts),
  };
}
