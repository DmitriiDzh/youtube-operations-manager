import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createIdGenerator } from "../contracts";

// Not changesets' own logic -- a generic "read a channel + its synced videos" accessor, owned by
// `@/lib/channel-video-store` (AGENTS.md §M). Kept here as a re-export under its historical name
// only because it is still reached into directly by two excluded-from-refactor modules
// (`agent-operations`, `ai-localization`); every other caller imports the real module directly.
export { createChannelVideoStoreAdapter as createChangeSetChannelStoreAdapter };

export { createIdGenerator };
