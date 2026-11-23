import { createCrossPostingCore, createCrossPostRunner, createSocialJobStore, postingEnabled, slotsBeyondLookback, type CrossPostRunner, type PlannedCrossPost } from "@/lib/cross-posting";
import { listSocialAccounts } from "@/lib/db";
import { createMetaClient } from "@/lib/social-gateway";
import { stillApprovedVia } from "./cross-posting-approval";
import { plannedCrossPostsOf, sha256OfFile, uploadBodyOf } from "./cross-posting-plan";

// BL-252 stage 2 (ADR 0068 amendment 1 §5): the cross-posting runner of this process, composed here so `cross-posting` never imports
// the plan or publishing modules. ONE runner per process on `globalThis` (instrumentation and the routes are separate bundles; a
// second runner would take a live upload for an interrupted one). Started by `src/instrumentation.ts`, once a minute.

const RUNNER_KEY = Symbol.for("ytom.crossPosting.runner");
const holder = globalThis as unknown as Record<symbol, CrossPostRunner | undefined>;

/**
 * The slots around now, plus (owner TG 4780) `slotsBeyondLookback`: those of a pending owner retry or a job still in flight, however
 * long ago -- read with the same approval rules; only their age no longer hides them.
 */
async function allEntries(jobs: ReturnType<typeof createSocialJobStore>): Promise<PlannedCrossPost[]> {
  const channels = [...new Set((await listSocialAccounts(null)).map((a) => a.channelId))];
  const known = await jobs.list(null).catch(() => []);
  const out: PlannedCrossPost[] = [];
  for (const channelId of channels) {
    out.push(...(await plannedCrossPostsOf(channelId, { alsoSlotIds: slotsBeyondLookback(known, channelId) }).catch(() => [])));
  }
  return out;
}

export function getCrossPostRunner(): CrossPostRunner {
  if (!holder[RUNNER_KEY]) {
    const core = createCrossPostingCore();
    const jobs = createSocialJobStore();
    holder[RUNNER_KEY] = createCrossPostRunner({
      plan: {
        entries: () => allEntries(jobs),
        // Re-read right before each publishing call: the slot still approved for the SAME manifest (released or not), its own slot
        // read whatever its age (`cross-posting-approval.ts`).
        stillApproved: stillApprovedVia(plannedCrossPostsOf),
      },
      jobs,
      // AC-XP-8 per network (owner TG 4779): each network's own identity read; another network's problem never refuses it.
      postingTarget: (channelId, network) => core.postingTarget(channelId, network),
      meta: createMetaClient({ postingAllowed: postingEnabled }),
      files: { body: uploadBodyOf, sha256: sha256OfFile },
      enabled: postingEnabled,
      now: () => Date.now(),
      // AC-XP-16, per network: Instagram as Meta counts it (unknown = wait), a Facebook Page by this computer's own count.
      quotaOk: (channelId, network) => core.quotaAllows(channelId, network),
    });
  }
  return holder[RUNNER_KEY];
}
