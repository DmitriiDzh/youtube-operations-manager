import assert from "node:assert/strict";
import test from "node:test";
import type { EveningChannelOutcome } from "@/lib/analytics";
import { createEveningCollectHandler, type EveningCollectDeps } from "./route";

// BL-181 (FO-REQ-0020 §2.3; plan REPORTING_BASIC_PLAN.md §2 item 7). The dashboard calls this route every 5 minutes. Requirements:
// before the evening boundary and once every channel's evening is settled it answers from local settings only (no lock, no peer
// import, no collection); it never runs beside the daily all-channels run (shared lock); it waits while the other computer's rows
// are still importing; the response names only the session's active channel (ADR 0004).

function deps(over: Partial<EveningCollectDeps> & { outcomes?: EveningChannelOutcome[]; window?: { open: boolean; localDate: string | null } } = {}) {
  const calls = { runs: 0, imports: 0, begins: 0, ends: 0, publishes: 0 };
  const d: EveningCollectDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      getEveningWindow: async () => over.window ?? { open: true, localDate: "2026-10-13" },
      runEveningCollectionForChannels: async () => {
        calls.runs += 1;
        return { channels: over.outcomes ?? [{ channelId: "UC_A", outcome: "collected" }, { channelId: "UC_B", outcome: "skipped", reason: "data_current" }] };
      },
    },
    getActiveChannelId: async () => "UC_A",
    beginRun: () => {
      calls.begins += 1;
      return true;
    },
    endRun: () => {
      calls.ends += 1;
    },
    importPeers: async () => {
      calls.imports += 1;
      return { imported: 0, pending: false };
    },
    publishLocal: async () => {
      calls.publishes += 1;
    },
    memo: { doneFor: null },
    ...over,
  };
  return { d, calls };
}

test("before the boundary: answers 'not due' from settings only", async () => {
  const { d, calls } = deps({ window: { open: false, localDate: "2026-10-13" } });
  assert.deepEqual(await (await createEveningCollectHandler(d)()).json(), { due: false });
  assert.deepEqual(calls, { runs: 0, imports: 0, begins: 0, ends: 0, publishes: 0 });
});

test("after the boundary: imports peers first, runs every channel under the shared lock, returns only the active channel", async () => {
  const { d, calls } = deps();
  const body = await (await createEveningCollectHandler(d)()).json();
  assert.deepEqual(body, { due: true, channels: [{ channelId: "UC_A", outcome: "collected" }] });
  assert.deepEqual(calls, { runs: 1, imports: 1, begins: 1, ends: 1, publishes: 1 });
  assert.equal(d.memo.doneFor, "2026-10-13", "every channel is settled: later calls this evening answer at once");
  assert.deepEqual(await (await createEveningCollectHandler(d)()).json(), { due: false, done: true });
  assert.equal(calls.runs, 1);
});

test("a channel held back by the quota reserve keeps the evening open; the next call tries again", async () => {
  const { d, calls } = deps({ outcomes: [{ channelId: "UC_A", outcome: "skipped", reason: "quota_reserve" }] });
  await createEveningCollectHandler(d)();
  assert.equal(d.memo.doneFor, null);
  assert.equal(calls.publishes, 0, "nothing collected, nothing to publish");
});

test("the daily run holds the lock: nothing runs; peers still importing: nothing runs and the lock is released", async () => {
  const busy = deps({ beginRun: () => false });
  assert.deepEqual(await (await createEveningCollectHandler(busy.d)()).json(), { due: true, inProgress: true });
  assert.equal(busy.calls.runs, 0);

  const pending = deps({ importPeers: async () => ({ imported: 0, pending: true }) });
  assert.deepEqual(await (await createEveningCollectHandler(pending.d)()).json(), { due: true, importPending: true });
  assert.equal(pending.calls.runs, 0);
  assert.equal(pending.calls.ends, 1);
});

test("no session: 401", async () => {
  const { d } = deps({ getSession: async () => null });
  assert.equal((await createEveningCollectHandler(d)()).status, 401);
});
