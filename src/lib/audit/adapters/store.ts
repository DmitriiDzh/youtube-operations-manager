import { insertAuditEvent, listAuditEventsByBatch, listAuditEventsByLedgerRow } from "@/lib/db";

export function createAuditStoreAdapter() {
  return {
    insertEvent: insertAuditEvent,
    listEventsByLedgerRow: listAuditEventsByLedgerRow,
    listEventsByBatch: listAuditEventsByBatch,
  };
}
