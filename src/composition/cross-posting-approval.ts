import type { PlannedCrossPost } from "@/lib/cross-posting";

// BL-252 (ADR 0068 amendment 2, owner TG 4780): the runner's approval re-check, kept apart from `cross-posting-runner.ts` so it can be
// tested without the database. Right before each publishing call the slot must still be approved for the SAME manifest. The entry's
// own slot is read whatever its age (`alsoSlotIds`): it is in this run because it is recent, because the owner retried it, or because
// its job is still in flight (an Instagram container published on a later pass, possibly more than 36 h after the slot's time) --
// the approval rules are the same; only the age no longer hides it (fix f90c4761).

export type PlanRead = (channelId: string, opts: { alsoSlotIds?: readonly string[] }) => Promise<PlannedCrossPost[]>;

export function stillApprovedVia(read: PlanRead): (entry: PlannedCrossPost) => Promise<boolean> {
  return async (entry) => (await read(entry.channelId, { alsoSlotIds: [entry.slotId] }).catch(() => [])).some((e) => e.slotId === entry.slotId && e.manifestSha256 === entry.manifestSha256);
}
