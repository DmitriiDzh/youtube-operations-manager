import { createAuditStoreAdapter } from "./adapters/store";
import { createAuditServices } from "./services";

export function createAuditCore() {
  return createAuditServices({ store: createAuditStoreAdapter() });
}

export type AuditCore = ReturnType<typeof createAuditCore>;
