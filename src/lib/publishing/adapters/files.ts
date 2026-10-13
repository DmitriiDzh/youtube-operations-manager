// The shared workspace rule (`workspace-exchange`): a path relative to the channel workspace, proven inside it after symlinks.
export { createExchangeFs as createWorkspaceExchangeFsForPublishing, resolveWorkspaceFile as resolveWorkspaceFileForPublishing } from "@/lib/workspace-exchange";
