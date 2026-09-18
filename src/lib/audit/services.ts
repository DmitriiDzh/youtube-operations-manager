import type { AuditEvent, AuditEventType } from "./contracts";

type StoredAuditEventRecord = {
  id: number;
  batchId: string;
  ledgerRowId: string;
  videoId: string;
  eventType: AuditEventType;
  detail: unknown;
  occurredAt: Date;
};

type AuditStoreDeps = {
  insertEvent(input: {
    batchId: string;
    ledgerRowId: string;
    videoId: string;
    eventType: AuditEventType;
    detail: unknown;
  }): Promise<void>;
  listEventsByLedgerRow(ledgerRowId: string): Promise<StoredAuditEventRecord[]>;
  listEventsByBatch(batchId: string): Promise<StoredAuditEventRecord[]>;
};

type ServiceDependencies = {
  store: AuditStoreDeps;
};

function toAuditEvent(record: StoredAuditEventRecord): AuditEvent {
  return {
    id: record.id,
    batchId: record.batchId,
    ledgerRowId: record.ledgerRowId,
    videoId: record.videoId,
    eventType: record.eventType,
    detail: record.detail,
    occurredAt: record.occurredAt.toISOString(),
  };
}

export function createAuditServices(deps: ServiceDependencies) {
  async function record(input: {
    batchId: string;
    ledgerRowId: string;
    videoId: string;
    eventType: AuditEventType;
    detail: unknown;
  }): Promise<void> {
    await deps.store.insertEvent(input);
  }

  /** Ordered exactly as stored (append-only, id-ordered) -- AC-AUDIT-01/04's "full
   * execution sequence for any video is reconstructable from the audit trail alone". */
  async function listForLedgerRow(ledgerRowId: string): Promise<AuditEvent[]> {
    const rows = await deps.store.listEventsByLedgerRow(ledgerRowId);
    return rows.map(toAuditEvent);
  }

  async function listForBatch(batchId: string): Promise<AuditEvent[]> {
    const rows = await deps.store.listEventsByBatch(batchId);
    return rows.map(toAuditEvent);
  }

  return { record, listForLedgerRow, listForBatch };
}

export type AuditServices = ReturnType<typeof createAuditServices>;
