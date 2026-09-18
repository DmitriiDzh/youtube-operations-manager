// AC-AUDIT-01/04: no event lost, sequence reconstructable in order, append-only.
import assert from "node:assert/strict";
import test from "node:test";
import { createAuditServices } from "./services";

function createFakeStore() {
  const events: Array<{
    id: number;
    batchId: string;
    ledgerRowId: string;
    videoId: string;
    eventType: "PREPARATION" | "ATTEMPT" | "RESULT" | "CONFLICT" | "VERIFICATION" | "DRY_RUN" | "RECONCILIATION";
    detail: unknown;
    occurredAt: Date;
  }> = [];
  let nextId = 1;

  return {
    async insertEvent(input: {
      batchId: string;
      ledgerRowId: string;
      videoId: string;
      eventType: typeof events[number]["eventType"];
      detail: unknown;
    }) {
      events.push({ id: nextId++, occurredAt: new Date(), ...input });
    },
    async listEventsByLedgerRow(ledgerRowId: string) {
      return events.filter((e) => e.ledgerRowId === ledgerRowId).sort((a, b) => a.id - b.id);
    },
    async listEventsByBatch(batchId: string) {
      return events.filter((e) => e.batchId === batchId).sort((a, b) => a.id - b.id);
    },
  };
}

test("audit trail preserves insertion order and every recorded event", async () => {
  const services = createAuditServices({ store: createFakeStore() });

  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "PREPARATION", detail: {} });
  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "ATTEMPT", detail: { attemptNumber: 1 } });
  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "RESULT", detail: { outcome: "FAILED" } });
  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "ATTEMPT", detail: { attemptNumber: 2 } });
  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "RESULT", detail: { outcome: "SUCCESS" } });
  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "VERIFICATION", detail: {} });

  const events = await services.listForLedgerRow("r1");
  assert.deepEqual(
    events.map((e) => e.eventType),
    ["PREPARATION", "ATTEMPT", "RESULT", "ATTEMPT", "RESULT", "VERIFICATION"]
  );
});

test("audit events for different ledger rows in the same batch are queryable independently or together", async () => {
  const services = createAuditServices({ store: createFakeStore() });

  await services.record({ batchId: "b1", ledgerRowId: "r1", videoId: "v1", eventType: "PREPARATION", detail: {} });
  await services.record({ batchId: "b1", ledgerRowId: "r2", videoId: "v2", eventType: "PREPARATION", detail: {} });
  await services.record({ batchId: "b1", ledgerRowId: "r2", videoId: "v2", eventType: "DRY_RUN", detail: {} });

  assert.equal((await services.listForLedgerRow("r1")).length, 1);
  assert.equal((await services.listForLedgerRow("r2")).length, 2);
  assert.equal((await services.listForBatch("b1")).length, 3);
});
