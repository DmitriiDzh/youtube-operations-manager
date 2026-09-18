// Phase 5, Slice 3 (RECOVERY AND AUDIT). Implements §25 / docs/acceptance/
// PHASE_5_ACCEPTANCE.md AC-AUDIT-01..05. A separate module (not part of
// src/lib/batches/), per docs/PROJECT_SPEC.md §47's three-module shape (backup/, audit/,
// batches/) and docs/DEVELOPMENT_PLAYBOOK.md §6.5.
//
// INV-11 (revised): every stage of a video's write lifecycle produces a durable audit
// event; no event is ever lost; no event is fabricated for something that did not occur.
// Exactly-one-record-per-video is explicitly NOT required -- a retried/reconciled video
// legitimately produces more events than one that succeeded on the first attempt.

export type AuditEventType =
  | "PREPARATION"
  | "ATTEMPT"
  | "RESULT"
  | "CONFLICT"
  | "VERIFICATION"
  | "DRY_RUN"
  | "RECONCILIATION";

export type AuditEvent = {
  id: number;
  batchId: string;
  ledgerRowId: string;
  videoId: string;
  eventType: AuditEventType;
  detail: unknown;
  occurredAt: string;
};

/**
 * §0.F's causation note / AC-AUDIT-05: a RESULT event must record only what is actually
 * known. `ownResponseObserved: true` means this attempt's own transport response was
 * observed (a normal 200, or a definitive error) -- causation may be attributed to this
 * specific attempt. `ownResponseObserved: false` means the result was established via
 * reconciliation (a fresh remote read matched the desired state) -- the event may record
 * that the target state was reached, but must never claim this attempt's own API call was
 * observed to have caused it.
 */
export type ResultEventDetail = {
  attemptId: string;
  attemptNumber: number;
  outcome: "SUCCESS" | "FAILED" | "UNKNOWN";
  ownResponseObserved: boolean;
  detail?: string;
};
