import { createDiskGuardCore, type DiskGuard } from "@/lib/disk-guard";
import { getSystemTopicCore } from "./system-topic-approvals";

/**
 * BL-237: the disk guard with its one outside connection, the HUB "System" topic (AGENTS.md §M: disk-guard imports no other
 * feature module). A message is queued for the hub only while the topic is active on this computer (switch on, Mac service,
 * ids and relay secret set); otherwise nothing is queued -- rows nobody would ever take -- and the bell alone tells the owner.
 */
export function systemTopicPoster(
  topic: { view(): Promise<{ active: boolean }>; enqueue(text: string): Promise<void> } = getSystemTopicCore().topic
): (text: string) => Promise<boolean> {
  return async (text) => {
    if (!(await topic.view()).active) return false;
    await topic.enqueue(text);
    return true;
  };
}

const CORE_KEY = Symbol.for("youtube-operations-manager.disk-guard");

/** One instance per process (the routes and the server's loop are separate bundles). */
export function getDiskGuardCore(): DiskGuard {
  const holder = globalThis as unknown as Record<symbol, DiskGuard | undefined>;
  return (holder[CORE_KEY] ??= createDiskGuardCore({
    // Resolved at the moment of posting: the System topic's core is created only when an alert actually goes out.
    postSystemMessage: (text) => systemTopicPoster()(text),
  }));
}
