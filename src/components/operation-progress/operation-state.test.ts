import assert from "node:assert/strict";
import test from "node:test";
import {
  IDLE_OPERATION,
  isOperationActive,
  operationReducer,
  type OperationAction,
  type OperationItem,
  type OperationState,
} from "./operation-state";

const items = (...ids: string[]): OperationItem[] => ids.map((id) => ({ id, label: id, status: "pending" }));
const run = (state: OperationState, ...actions: OperationAction[]) => actions.reduce(operationReducer, state);

test("start: running, nothing done, total from items, timestamp recorded", () => {
  const s = run(IDLE_OPERATION, { type: "start", title: "Writing", items: items("a", "b", "c"), now: 1000 });
  assert.equal(s.status, "running");
  assert.equal(s.total, 3);
  assert.equal(s.done, 0);
  assert.equal(s.startedAt, 1000);
  assert.equal(isOperationActive(s), true);
});

test("done counts only items in a final state: done, failed and skipped yes, running no", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", items: items("a", "b", "c", "d"), now: 0 },
    { type: "item", id: "a", status: "done" },
    { type: "item", id: "b", status: "failed", detail: "boom" },
    { type: "item", id: "c", status: "running" }
  );
  assert.equal(s.done, 2);
  assert.equal(s.total, 4);
  assert.equal(s.items[1].detail, "boom");
});

test("re-reporting the same final status never double counts", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", items: items("a", "b"), now: 0 },
    { type: "item", id: "a", status: "done" },
    { type: "item", id: "a", status: "done" }
  );
  assert.equal(s.done, 1);
});

test("counts action (server-reported progress) is clamped to 0..total", () => {
  const s = run(IDLE_OPERATION, { type: "start", title: "t", total: 5, now: 0 }, { type: "counts", done: 9, total: 5 });
  assert.equal(s.done, 5);
  const t = run(s, { type: "counts", done: -3, total: 5 });
  assert.equal(t.done, 0);
});

test("cancel is honoured only when the operation declared itself cancellable", () => {
  const plain = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 }, { type: "requestCancel" });
  assert.equal(plain.status, "running");
  const cancellable = run(IDLE_OPERATION, { type: "start", title: "t", cancellable: true, now: 0 }, { type: "requestCancel" });
  assert.equal(cancellable.status, "cancelling");
  assert.equal(isOperationActive(cancellable), true);
});

test("finish after a cancel request reports cancelled, not success", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", cancellable: true, now: 0 },
    { type: "requestCancel" },
    { type: "finish", now: 50, message: "Stopped" }
  );
  assert.equal(s.status, "cancelled");
  assert.equal(s.finishedAt, 50);
  assert.equal(s.message, "Stopped");
  assert.equal(isOperationActive(s), false);
});

test("finish with error is failed even if a cancel was requested; plain finish is success", () => {
  const failed = run(
    IDLE_OPERATION,
    { type: "start", title: "t", cancellable: true, now: 0 },
    { type: "requestCancel" },
    { type: "finish", error: true, message: "x", now: 1 }
  );
  assert.equal(failed.status, "failed");
  const ok = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 }, { type: "finish", now: 1 });
  assert.equal(ok.status, "success");
});

test("updates after the operation ended are ignored (a late poll cannot revive or alter it)", () => {
  const ended = run(IDLE_OPERATION, { type: "start", title: "t", items: items("a"), now: 0 }, { type: "finish", now: 1 });
  const after = run(ended, { type: "item", id: "a", status: "done" }, { type: "counts", done: 1, total: 1 }, { type: "stage", stage: "x" });
  assert.deepEqual(after, ended);
});

test("reset returns to idle; finish on idle is a no-op", () => {
  const s = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 }, { type: "finish", now: 1 }, { type: "reset" });
  assert.deepEqual(s, IDLE_OPERATION);
  assert.deepEqual(run(IDLE_OPERATION, { type: "finish", now: 1 }), IDLE_OPERATION);
});

test("setItems (items discovered after start, e.g. from a polled ledger) recomputes total and done", () => {
  const polled: OperationItem[] = [
    { id: "a", label: "a", status: "done" },
    { id: "b", label: "b", status: "running" },
  ];
  const s = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 }, { type: "setItems", items: polled });
  assert.equal(s.total, 2);
  assert.equal(s.done, 1);
});

test("quota: the first reading becomes the baseline, later readings update used but keep it", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", now: 0 },
    { type: "quota", service: "dataApi", used: 1000, limit: 10000 },
    { type: "quota", service: "dataApi", used: 1054, limit: 10000 }
  );
  assert.deepEqual(s.quotas, [{ service: "dataApi", used: 1054, limit: 10000, baseline: 1000 }]);
});

test("quota: two services are tracked independently", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", now: 0 },
    { type: "quota", service: "dataApi", used: 5, limit: 10000 },
    { type: "quota", service: "analytics", used: 7, limit: 100000 }
  );
  assert.equal(s.quotas.length, 2);
});

test("quota: invalid readings (limit 0, negative usage) and readings on idle are ignored", () => {
  const started = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 });
  assert.deepEqual(run(started, { type: "quota", service: "dataApi", used: 1, limit: 0 }).quotas, []);
  assert.deepEqual(run(started, { type: "quota", service: "dataApi", used: -1, limit: 10 }).quotas, []);
  assert.deepEqual(run(IDLE_OPERATION, { type: "quota", service: "dataApi", used: 1, limit: 10 }), IDLE_OPERATION);
});

test("quota: a final reading after finish is still accepted (Google reports with a delay)", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "t", now: 0 },
    { type: "quota", service: "dataApi", used: 100, limit: 10000 },
    { type: "finish", now: 1 },
    { type: "quota", service: "dataApi", used: 154, limit: 10000 }
  );
  assert.equal(s.status, "success");
  assert.equal(s.quotas[0].used - s.quotas[0].baseline, 54);
});

test("quota: a new operation starts with no quota readings", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "a", now: 0 },
    { type: "quota", service: "dataApi", used: 1, limit: 10 },
    { type: "start", title: "b", now: 5 }
  );
  assert.deepEqual(s.quotas, []);
});

test("sync mirrors a server snapshot: items, counts, status, timestamps", () => {
  const s = run(
    IDLE_OPERATION,
    { type: "start", title: "Starting", cancellable: false, now: 0 },
    {
      type: "sync",
      snapshot: {
        title: "Writing",
        status: "cancelling",
        stage: "Writing language labels",
        items: [
          { id: "a", label: "a", status: "done" },
          { id: "b", label: "b", status: "running" },
          { id: "c", label: "c", status: "pending" },
        ],
        cancellable: true,
        message: null,
        startedAt: 100,
        finishedAt: null,
      },
    }
  );
  assert.equal(s.status, "cancelling");
  assert.equal(s.total, 3);
  assert.equal(s.done, 1);
  assert.equal(s.startedAt, 100);
  assert.equal(s.title, "Writing");
});

test("sync with a final server status ends the operation; later syncs after reset are ignored", () => {
  const snapshot = {
    title: "Writing",
    status: "failed" as const,
    stage: null,
    items: [{ id: "a", label: "a", status: "failed" as const, detail: "boom" }],
    cancellable: true,
    message: "Stopped at the first error: boom",
    startedAt: 1,
    finishedAt: 9,
  };
  const ended = run(IDLE_OPERATION, { type: "start", title: "t", now: 0 }, { type: "sync", snapshot });
  assert.equal(ended.status, "failed");
  assert.equal(isOperationActive(ended), false);
  assert.equal(ended.finishedAt, 9);
  assert.deepEqual(run(ended, { type: "reset" }, { type: "sync", snapshot }), IDLE_OPERATION);
});
