export {
  createAutomergeCore,
  type AutomergeCore,
  type AutomergeCoreDeps,
  type ConflictLike,
  type MergeOutcome,
  type DiscardAndAdoptOutcome,
} from "./engine";
export { createFilesystemDocumentStore, createDiscardedDocumentBackupStore, type DocumentByteStore, type DiscardedDocumentBackupStore } from "./store";
export { createPerChannelFilesystemTransport, type PerChannelTransportAdapter } from "./transport";
export {
  createSyncRunner,
  type SyncRunner,
  type SyncRunnerDeps,
  type SyncCycleResult,
  type ChannelSyncResult,
  type DocumentFamilyForSync,
  type BootstrapConfigLike,
  type SyncRunnerLogger,
} from "./sync-runner";
