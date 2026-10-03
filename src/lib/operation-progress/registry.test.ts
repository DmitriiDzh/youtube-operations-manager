import assert from "node:assert/strict";
import test from "node:test";
import { OperationAlreadyRunningError } from "./contracts";
import { createOperationRegistry } from "./registry";

// Expected values follow ADR 0015: cooperative cancel only for running + cancellable operations,
// one active run per (channel, kind), a dead heartbeat can never keep an operation "running",
// finished results stay readable for a while so a reloaded page can still see them.

function setup(opts: { heartbeatTimeoutMs?: number; retainFinishedMs?: number } = {}) {
  let t = 1_000;
  let n = 0;
  const registry = createOperationRegistry({ now: () => t, idGenerator: () => `op-${++n}`, ...opts });
  return { registry, advance: (ms: number) => void (t += ms) };
}

const input = (over: Partial<Parameters<ReturnType<typeof createOperationRegistry>["start"]>[0]> = {}) => ({
  kind: "language-fix-all",
  channelId: "UC1",
  title: "Fix all",
  items: [
    { id: "a", label: "Video A" },
    { id: "b", label: "Video B" },
  ],
  cancellable: true,
  ...over,
});

test("start: running, all items pending, nothing done, total = item count", () => {
  const { registry } = setup();
  const handle = registry.start(input());
  const snap = registry.get(handle.id)!;
  assert.equal(snap.status, "running");
  assert.equal(snap.total, 2);
  assert.equal(snap.done, 0);
  assert.deepEqual(snap.items.map((i) => i.status), ["pending", "pending"]);
});

test("done counts final item states only", () => {
  const { registry } = setup();
  const handle = registry.start(input());
  handle.setItem("a", "done");
  handle.setItem("b", "running");
  assert.equal(registry.get(handle.id)!.done, 1);
  handle.setItem("b", "failed", "boom");
  const snap = registry.get(handle.id)!;
  assert.equal(snap.done, 2);
  assert.equal(snap.items[1].detail, "boom");
});

test("a second run of the same kind on the same channel is refused; another channel or kind is fine", () => {
  const { registry } = setup();
  const first = registry.start(input());
  assert.throws(
    () => registry.start(input()),
    (e: unknown) => e instanceof OperationAlreadyRunningError && e.operationId === first.id
  );
  registry.start(input({ channelId: "UC2" }));
  registry.start(input({ kind: "other" }));
});

test("after the first run finishes, the same kind can start again", () => {
  const { registry } = setup();
  registry.start(input()).finish();
  registry.start(input());
});

test("cancel: accepted while running, moves to cancelling, the handle sees the flag, finish reports cancelled", () => {
  const { registry } = setup();
  const handle = registry.start(input());
  assert.equal(handle.isCancelRequested(), false);
  assert.equal(registry.requestCancel(handle.id), true);
  assert.equal(registry.get(handle.id)!.status, "cancelling");
  assert.equal(handle.isCancelRequested(), true);
  handle.finish({ message: "stopped" });
  assert.equal(registry.get(handle.id)!.status, "cancelled");
});

test("cancel is refused for a non-cancellable operation, a finished one, and an unknown id", () => {
  const { registry } = setup();
  const fixed = registry.start(input({ cancellable: false }));
  assert.equal(registry.requestCancel(fixed.id), false);
  assert.equal(registry.get(fixed.id)!.status, "running");
  const done = registry.start(input({ channelId: "UC2" }));
  done.finish();
  assert.equal(registry.requestCancel(done.id), false);
  assert.equal(registry.requestCancel("nope"), false);
});

test("finish with error is failed even after a cancel request; updates after finish are ignored", () => {
  const { registry } = setup();
  const handle = registry.start(input());
  registry.requestCancel(handle.id);
  handle.finish({ error: true, message: "x" });
  assert.equal(registry.get(handle.id)!.status, "failed");
  handle.setItem("a", "done");
  handle.setStage("late");
  const snap = registry.get(handle.id)!;
  assert.equal(snap.items[0].status, "pending");
  assert.equal(snap.stage, null);
});

test("heartbeat: an operation silent past the timeout becomes failed, its unfinished items skipped, and it stops blocking a new run", () => {
  const { registry, advance } = setup({ heartbeatTimeoutMs: 60_000 });
  const handle = registry.start(input());
  handle.setItem("a", "done");
  advance(59_000);
  assert.equal(registry.get(handle.id)!.status, "running");
  advance(2_000);
  const snap = registry.get(handle.id)!;
  assert.equal(snap.status, "failed");
  assert.match(snap.message ?? "", /Interrupted/);
  assert.deepEqual(snap.items.map((i) => i.status), ["done", "skipped"]);
  registry.start(input());
});

test("any handle call refreshes the heartbeat", () => {
  const { registry, advance } = setup({ heartbeatTimeoutMs: 60_000 });
  const handle = registry.start(input());
  advance(50_000);
  handle.touch();
  advance(50_000);
  assert.equal(registry.get(handle.id)!.status, "running");
});

test("finished operations stay readable for the retention window, then disappear", () => {
  const { registry, advance } = setup({ retainFinishedMs: 10_000 });
  const handle = registry.start(input());
  handle.finish();
  advance(9_000);
  assert.ok(registry.get(handle.id));
  advance(2_000);
  assert.equal(registry.get(handle.id), undefined);
});

test("list is scoped to the channel, filters by kind / activeOnly, newest first", () => {
  const { registry, advance } = setup();
  const old = registry.start(input());
  old.finish();
  advance(10);
  const recent = registry.start(input());
  registry.start(input({ channelId: "UC2" }));
  registry.start(input({ kind: "other" }));
  assert.deepEqual(registry.list({ channelId: "UC1", kind: "language-fix-all" }).map((s) => s.id), [recent.id, old.id]);
  assert.deepEqual(registry.list({ channelId: "UC1", kind: "language-fix-all", activeOnly: true }).map((s) => s.id), [recent.id]);
  assert.equal(registry.list({ channelId: "UC3" }).length, 0);
});
