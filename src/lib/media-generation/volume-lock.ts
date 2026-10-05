import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// Phase 14 (review round 9, AGENTS.md §M): ONE database-enforced "the network volume is busy" lock that
// every writer to the volume takes -- a GPU session (from its `approved` write until it is terminal), a
// model pull (from its reservation until it is terminal) and an operator pod mounting the volume (from
// its createPod until it is gone). AC-P14-18 (no GPU session while a pull writes `models/`, and the
// reverse) is thereby a constraint -- one row that only one owner can insert -- not a two-sided
// check/reserve/re-check protocol each side has to replicate.
//
// The row survives a crash (it is in the database), so an acquire that finds a holder asks whether that
// holder is still active (a session past `approved`, a running pull, a live pod); a stale holder is stolen
// -- but only once the lock is older than a grace period (review round 13): an owner acquires BEFORE its
// own row becomes visible (approve → `approved` write, pull → reservation), and in that window it is not
// yet "active" to the staleness check although it is very much alive.
// ---------------------------------------------------------------------------

/** An acquire older than this whose owner is still not visibly active was left behind by a crash. */
export const VOLUME_LOCK_STALE_AFTER_MS = 2 * 60_000;

export type VolumeLockHolder = { owner: string; since: Date };

export type VolumeLockStore = {
  /** Atomic insert-if-absent; `holder` is whoever holds the lock afterwards (the caller when acquired). */
  tryAcquire(owner: string, at: Date): Promise<{ acquired: boolean; holder: VolumeLockHolder }>;
  /** Removes the row only if `owner` holds it; `false` when it did not. */
  release(owner: string): Promise<boolean>;
  holder(): Promise<VolumeLockHolder | null>;
};

export type VolumeLockOwner = `session:${string}` | `pull:${string}` | `pod:${string}`;

export type VolumeLock = {
  /** Takes the lock for `owner` or throws `media_session_conflict` naming the holder. Re-entrant for the same owner. */
  acquire(owner: VolumeLockOwner): Promise<void>;
  release(owner: VolumeLockOwner): Promise<boolean>;
  holder(): Promise<VolumeLockHolder | null>;
};

export function describeVolumeLockHolder(holder: string): string {
  if (holder.startsWith("session:")) return `A generation session (${holder.slice("session:".length)}) is open on the network volume; stop it first (Settings → Media → Sessions).`;
  if (holder.startsWith("pull:")) return `A model pull (${holder.slice("pull:".length)}) is writing to the network volume; wait for it to finish (Settings → Media → Models).`;
  if (holder.startsWith("pod:")) return `An operator pod (${holder.slice("pod:".length)}) has the network volume mounted; terminate it first (media pod-terminate).`;
  return `The network volume is busy (${holder}).`;
}

export function createVolumeLock(deps: { store: VolumeLockStore; isHolderActive(holder: string): Promise<boolean>; clock?: { now(): Date }; log?: (line: string) => void }): VolumeLock {
  const log = deps.log ?? (() => undefined);
  const now = () => (deps.clock ?? { now: () => new Date() }).now();
  return {
    async acquire(owner) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await deps.store.tryAcquire(owner, now());
        if (result.acquired || result.holder.owner === owner) return;
        const conflict = () =>
          new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(result.holder.owner), details: { holder: result.holder.owner, since: result.holder.since.toISOString() } });
        if (await deps.isHolderActive(result.holder.owner)) throw conflict();
        // Not visibly active: either its own row is not written yet (acquire precedes the write by milliseconds) or a
        // crash left it. Only age tells them apart.
        if (now().getTime() - result.holder.since.getTime() < VOLUME_LOCK_STALE_AFTER_MS) throw conflict();
        log(`[media] volume lock held by inactive ${result.holder.owner} since ${result.holder.since.toISOString()}; releasing it for ${owner}`);
        await deps.store.release(result.holder.owner);
      }
      const holder = await deps.store.holder();
      throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(holder?.owner ?? "unknown"), details: { holder: holder?.owner ?? null } });
    },
    release: (owner) => deps.store.release(owner),
    holder: () => deps.store.holder(),
  };
}

/** An in-memory store with the same atomic semantics (tests, and the only other legitimate use: a dry-run core). */
export function createMemoryVolumeLockStore(): VolumeLockStore & { current: () => string | null } {
  let holder: VolumeLockHolder | null = null;
  return {
    async tryAcquire(owner, at) {
      if (holder === null) holder = { owner, since: at };
      return { acquired: holder.owner === owner, holder };
    },
    async release(owner) {
      if (holder?.owner !== owner) return false;
      holder = null;
      return true;
    },
    async holder() {
      return holder;
    },
    current: () => holder?.owner ?? null,
  };
}
