import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sleep } from "@/lib/shared-async";
import { createOperationWait, shutdownSignal, signalShutdown } from "./index";

// BL-271 (WAIT_TOOLS_PLAN.md AC-WT-07): a blocked wait returns within 1 s of the process's SIGTERM (server_stopping) and never holds
// the graceful stop. Its own file: the stop signal is process-wide (one per process, on globalThis).

test("AC-WT-07: the server's SIGTERM / SIGINT handlers call signalShutdown (src/instrumentation.ts)", async () => {
  const source = await readFile("src/instrumentation.ts", "utf8");
  assert.match(source, /process\.once\("SIGTERM", signalShutdown\)/);
  assert.match(source, /process\.once\("SIGINT", signalShutdown\)/);
});

test("AC-WT-07: a wait blocked in a real 240 s sleep returns server_stopping within 1 s of signalShutdown", async () => {
  const wait = createOperationWait({
    ports: { media_job: async () => ({ id: "j1", status: "generating", final: false, outcome: "still_running", snapshot: {} }) },
    now: () => Date.now(),
    sleep: (ms, signal) => sleep(ms, { signal }),
    shutdownSignal,
    restarting: async () => false,
    pollMs: { media_job: 240_000 },
  });
  const started = Date.now();
  const pending = wait.waitFor({ target: "media_job", id: "j1", timeoutSeconds: 240 }, { channelId: null });
  setTimeout(() => signalShutdown(), 50);
  const result = await pending;
  const took = Date.now() - started;
  assert.ok(took < 1050, `returned after ${took} ms`);
  assert.deepEqual([result.final, result.outcome], [false, "server_stopping"]);
  assert.equal(shutdownSignal().aborted, true, "the same signal for every caller in the process");
  // A wait started after the stop returns at once too.
  const after = await wait.waitFor({ target: "media_job", id: "j1", timeoutSeconds: 240 }, { channelId: null });
  assert.equal(after.outcome, "server_stopping");
});
