import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodApiClient } from "@/lib/media-gateway";
import { findLivePodByName, terminateAndConfirm } from "./pod-lifecycle";

// Review round 8 (AGENTS.md §M): the one pod-lifecycle implementation both sessions and model pulls use.
// Expected behaviour from PHASE_14_PLAN.md §2.3 ("terminated, never stopped; terminal only once confirmed").

function fakeClient(opts: { exists: boolean; terminalAfterPolls?: number; lingers?: boolean }) {
  let polls = 0;
  const calls: string[] = [];
  const client = {
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      return { terminated: true as const, alreadyGone: !opts.exists };
    },
    async getPod(id: string) {
      polls++;
      if (!opts.exists) return null;
      if (opts.lingers) return { id, status: "RUNNING" };
      return { id, status: polls >= (opts.terminalAfterPolls ?? 1) ? "TERMINATED" : "RUNNING" };
    },
    async listPods() {
      return [
        { id: "p1", name: "ytm-media-abc", status: "TERMINATED" },
        { id: "p2", name: "ytm-media-abc", status: "RUNNING" },
      ];
    },
  } as unknown as RunpodApiClient;
  return { client, calls };
}

function clock() {
  let now = 0;
  return { now: () => new Date(now), sleep: async (ms: number) => void (now += ms) };
}

test("terminateAndConfirm: terminate then poll until TERMINATED/absent; reports alreadyGone when RunPod had no such pod", async () => {
  const alive = fakeClient({ exists: true, terminalAfterPolls: 3 });
  assert.deepEqual(await terminateAndConfirm(alive.client, "p", clock(), { timeoutMs: 60_000, pollMs: 5_000 }), { confirmed: true, lastStatus: "TERMINATED", alreadyGone: false });
  assert.deepEqual(alive.calls, ["terminate:p"]);
  const gone = fakeClient({ exists: false });
  assert.deepEqual(await terminateAndConfirm(gone.client, "p", clock(), { timeoutMs: 60_000, pollMs: 5_000 }), { confirmed: true, lastStatus: null, alreadyGone: true });
});

test("terminateAndConfirm: a pod that lingers past the timeout is reported unconfirmed with its last status (the caller keeps retrying, never assumes)", async () => {
  const lingering = fakeClient({ exists: true, lingers: true });
  assert.deepEqual(await terminateAndConfirm(lingering.client, "p", clock(), { timeoutMs: 20_000, pollMs: 5_000 }), { confirmed: false, lastStatus: "RUNNING", alreadyGone: false });
});

test("findLivePodByName ignores a TERMINATED pod of the same name", async () => {
  const { client } = fakeClient({ exists: true });
  assert.equal((await findLivePodByName(client, "ytm-media-abc"))?.id, "p2");
  assert.equal(await findLivePodByName(client, "ytm-media-zzz"), undefined);
});
