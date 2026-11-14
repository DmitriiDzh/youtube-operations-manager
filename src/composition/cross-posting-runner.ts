import { createCrossPostingCore, createCrossPostRunner, createSocialJobStore, postingEnabled, type CrossPostRunner, type PlannedCrossPost } from "@/lib/cross-posting";
import { listSocialAccounts } from "@/lib/db";
import { createMetaClient } from "@/lib/social-gateway";
import { plannedCrossPostsOf, sha256OfFile, uploadBodyOf } from "./cross-posting-plan";

// BL-252 stage 2 (ADR 0068 amendment 1 §5): the cross-posting runner of this process, composed here so `cross-posting` never imports
// the plan or publishing modules. ONE runner per process on `globalThis` (instrumentation and the routes are separate bundles; a
// second runner would take a live upload for an interrupted one). Started by `src/instrumentation.ts`, once a minute.

const RUNNER_KEY = Symbol.for("ytom.crossPosting.runner");
const holder = globalThis as unknown as Record<symbol, CrossPostRunner | undefined>;

async function allEntries(): Promise<PlannedCrossPost[]> {
  const channels = [...new Set((await listSocialAccounts(null)).map((a) => a.channelId))];
  const out: PlannedCrossPost[] = [];
  for (const channelId of channels) out.push(...(await plannedCrossPostsOf(channelId).catch(() => [])));
  return out;
}

export function getCrossPostRunner(): CrossPostRunner {
  if (!holder[RUNNER_KEY]) {
    const core = createCrossPostingCore();
    const jobs = createSocialJobStore();
    holder[RUNNER_KEY] = createCrossPostRunner({
      plan: {
        entries: allEntries,
        // Re-read right before each publishing call: the slot still approved for the SAME manifest (released or not).
        stillApproved: async (entry) => (await plannedCrossPostsOf(entry.channelId).catch(() => [])).some((e) => e.slotId === entry.slotId && e.manifestSha256 === entry.manifestSha256),
      },
      jobs,
      postingTarget: (channelId) => core.postingTarget(channelId),
      meta: createMetaClient({ postingAllowed: postingEnabled }),
      files: { body: uploadBodyOf, sha256: sha256OfFile },
      enabled: postingEnabled,
      now: () => Date.now(),
      // AC-XP-16: Instagram as Meta counts it (unknown = wait), a Facebook Page by this computer's own count.
      quotaOk: async (channelId, network) => {
        const q = await core.quota(channelId);
        return network === "instagram" ? q.instagram.used !== null && q.instagram.used < q.instagram.limit : q.facebook.used < q.facebook.limit;
      },
    });
  }
  return holder[RUNNER_KEY];
}
