import type { RunpodApiClient, RunpodPod } from "@/lib/media-gateway";

// ---------------------------------------------------------------------------
// Phase 14 (review round 8, AGENTS.md §M): the pod-lifecycle steps that BOTH the GPU sessions
// (`sessions.ts`) and the CPU model pulls (`models.ts`) need, in one place -- terminate-and-confirm
// (never "stop": a stopped pod's disk bills double) and the deterministic-name lookup of a pod whose
// `createPod` call failed after RunPod created it. One copy, so a change in how RunPod reports a
// terminal pod is applied once.
// ---------------------------------------------------------------------------

export type TerminateOutcome = {
  /** RunPod confirmed the pod is gone (absent or TERMINATED) within the timeout. */
  confirmed: boolean;
  lastStatus: string | null;
  /** RunPod had no such pod BEFORE our terminate: it stopped billing at some unknown earlier time. */
  alreadyGone: boolean;
};

export type PodLifecycleClock = { now(): Date; sleep(ms: number): Promise<void> };

/** `terminatePod` then poll `getPod` until it is absent/TERMINATED or the timeout passes. */
export async function terminateAndConfirm(
  client: RunpodApiClient,
  podId: string,
  clock: PodLifecycleClock,
  timeouts: { timeoutMs: number; pollMs: number }
): Promise<TerminateOutcome> {
  const terminated = await client.terminatePod(podId);
  const alreadyGone = terminated.alreadyGone;
  const deadline = clock.now().getTime() + timeouts.timeoutMs;
  let lastStatus: string | null = null;
  for (;;) {
    const pod = await client.getPod(podId);
    if (!pod || pod.status === "TERMINATED") return { confirmed: true, lastStatus: pod?.status ?? null, alreadyGone };
    lastStatus = pod.status;
    if (clock.now().getTime() >= deadline) return { confirmed: false, lastStatus, alreadyGone };
    await clock.sleep(timeouts.pollMs);
  }
}

/** A live (non-TERMINATED) pod of the account with exactly this name, or undefined (the gateway follows the cursor pagination). */
export async function findLivePodByName(client: RunpodApiClient, name: string): Promise<RunpodPod | undefined> {
  return (await client.listPods()).find((p) => p.name === name && p.status !== "TERMINATED");
}
