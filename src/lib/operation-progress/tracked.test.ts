import assert from "node:assert/strict";
import test from "node:test";
import { OperationAlreadyRunningError } from "./contracts";
import { createOperationRegistry } from "./registry";
import { runTrackedOperation } from "./tracked";

// Requirements (ADR 0015): a blocking server operation is visible while it runs (stage and counts), ends
// as success / failed with the error text, the original result or error still reaches the caller
// unchanged, one run per (channel, kind), and cancel is cooperative and only for cancellable operations.

function setup() {
  let n = 0;
  const registry = createOperationRegistry({ idGenerator: () => `op-${++n}` });
  return { registry };
}

const base = { kind: "channel-sync", channelId: "UC1", title: "Syncing" };

test("progress is visible in the registry while the work runs, and the result is returned unchanged", async () => {
  const { registry } = setup();
  let seen: { stage: string | null; done: number; total: number; status: string } | null = null;

  const result = await runTrackedOperation({
    registry,
    ...base,
    cancellable: false,
    work: async (progress) => {
      progress.stage("Reading video details");
      progress.counts(50, 120);
      const snap = registry.list({ channelId: "UC1", activeOnly: true })[0];
      seen = { stage: snap.stage, done: snap.done, total: snap.total, status: snap.status };
      return { videoCount: 120 };
    },
    messageFor: (r) => `${r.videoCount} videos`,
  });

  assert.deepEqual(result, { videoCount: 120 });
  assert.deepEqual(seen, { stage: "Reading video details", done: 50, total: 120, status: "running" });
  const final = registry.list({ channelId: "UC1" })[0];
  assert.equal(final.status, "success");
  assert.equal(final.message, "120 videos");
});

test("counts are clamped to 0..total and a negative total becomes 0", async () => {
  const { registry } = setup();
  await runTrackedOperation({
    registry,
    ...base,
    cancellable: false,
    work: async (progress) => {
      progress.counts(99, 10);
      assert.equal(registry.list({ channelId: "UC1" })[0].done, 10);
      progress.counts(-5, 10);
      assert.equal(registry.list({ channelId: "UC1" })[0].done, 0);
      progress.counts(1, -3);
      assert.equal(registry.list({ channelId: "UC1" })[0].total, 0);
    },
  });
});

test("a failing work ends the operation as failed with the error message and rethrows the SAME error", async () => {
  const { registry } = setup();
  const boom = new Error("quota exhausted");
  await assert.rejects(
    () =>
      runTrackedOperation({
        registry,
        ...base,
        cancellable: false,
        work: async () => {
          throw boom;
        },
      }),
    (error: unknown) => error === boom
  );
  const final = registry.list({ channelId: "UC1" })[0];
  assert.equal(final.status, "failed");
  assert.equal(final.message, "quota exhausted");
});

test("a second run of the same kind on the same channel is refused before its work starts", async () => {
  const { registry } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = runTrackedOperation({ registry, ...base, cancellable: false, work: () => gate });
  let started = false;
  await assert.rejects(
    () =>
      runTrackedOperation({
        registry,
        ...base,
        cancellable: false,
        work: async () => {
          started = true;
        },
      }),
    OperationAlreadyRunningError
  );
  assert.equal(started, false);
  release();
  await first;
  // After the first ends, the same kind may run again.
  await runTrackedOperation({ registry, ...base, cancellable: false, work: async () => undefined });
});

test("cancel: a cancellable operation exposes the flag to its work and ends as cancelled", async () => {
  const { registry } = setup();
  let sawFlag = false;
  await runTrackedOperation({
    registry,
    ...base,
    kind: "ai-generation",
    cancellable: true,
    work: async (progress) => {
      assert.equal(progress.isCancelRequested(), false);
      const id = registry.list({ channelId: "UC1", activeOnly: true })[0].id;
      assert.equal(registry.requestCancel(id), true);
      sawFlag = progress.isCancelRequested();
    },
  });
  assert.equal(sawFlag, true);
  assert.equal(registry.list({ channelId: "UC1" })[0].status, "cancelled");
});

test("cancel is refused for a non-cancellable operation", async () => {
  const { registry } = setup();
  await runTrackedOperation({
    registry,
    ...base,
    cancellable: false,
    work: async () => {
      const id = registry.list({ channelId: "UC1", activeOnly: true })[0].id;
      assert.equal(registry.requestCancel(id), false);
    },
  });
});

test("every progress call is a heartbeat reported to the host", async () => {
  let beats = 0;
  const registry = createOperationRegistry({ onHeartbeat: () => void (beats += 1) });
  await runTrackedOperation({
    registry,
    ...base,
    cancellable: false,
    work: async (progress) => {
      const before = beats;
      progress.stage("x");
      progress.counts(1, 2);
      assert.equal(beats, before + 2);
    },
  });
});
