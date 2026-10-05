import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// Phase 14 (review round 9, AGENTS.md §M): ONE database-enforced "the network volume is busy" lock that
// every writer to the volume takes -- a GPU session (from its `approved` write until it is terminal)
// and a model pull (from its reservation until it is terminal). AC-P14-18 (no GPU session while a
// pull writes `models/`, and the reverse) is thereby a constraint -- one row that only one owner can
// insert -- not a two-sided check/reserve/re-check protocol each side has to replicate. A future
// writer (another pull type, a UI volume bootstrap) takes the same lock and is excluded the same way.
//
// The row survives a crash (it is in the database), so an acquire that finds a holder asks whether
// that holder is still active (a non-terminal session / a running pull); a stale holder is stolen.
// ---------------------------------------------------------------------------

export type VolumeLockStore = {
  /** Atomic insert-if-absent; `holder` is whoever holds the lock afterwards (the caller when acquired). */
  tryAcquire(owner: string): Promise<{ acquired: boolean; holder: string }>;
  /** Removes the row only if `owner` holds it; `false` when it did not. */
  release(owner: string): Promise<boolean>;
  holder(): Promise<string | null>;
};

export type VolumeLockOwner = `session:${string}` | `pull:${string}`;

export type VolumeLock = {
  /** Takes the lock for `owner` or throws `media_session_conflict` naming the holder. Re-entrant for the same owner. */
  acquire(owner: VolumeLockOwner): Promise<void>;
  release(owner: VolumeLockOwner): Promise<boolean>;
  holder(): Promise<string | null>;
};

export function describeVolumeLockHolder(holder: string): string {
  if (holder.startsWith("session:")) return `A generation session (${holder.slice("session:".length)}) is open on the network volume; stop it first (Settings → Media → Sessions).`;
  if (holder.startsWith("pull:")) return `A model pull (${holder.slice("pull:".length)}) is writing to the network volume; wait for it to finish (Settings → Media → Models).`;
  return `The network volume is busy (${holder}).`;
}

export function createVolumeLock(deps: { store: VolumeLockStore; isHolderActive(holder: string): Promise<boolean>; log?: (line: string) => void }): VolumeLock {
  const log = deps.log ?? (() => undefined);
  return {
    async acquire(owner) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await deps.store.tryAcquire(owner);
        if (result.acquired || result.holder === owner) return;
        if (await deps.isHolderActive(result.holder)) {
          throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(result.holder), details: { holder: result.holder } });
        }
        // Left behind by a crash between the holder's terminal write and its release: the holder is terminal, so the lock is stale.
        log(`[media] volume lock held by inactive ${result.holder}; releasing it for ${owner}`);
        await deps.store.release(result.holder);
      }
      const holder = (await deps.store.holder()) ?? "unknown";
      throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(holder), details: { holder } });
    },
    release: (owner) => deps.store.release(owner),
    holder: () => deps.store.holder(),
  };
}

/** An in-memory store with the same atomic semantics (tests, and the only other legitimate use: a dry-run core). */
export function createMemoryVolumeLockStore(): VolumeLockStore & { current: () => string | null } {
  let holder: string | null = null;
  return {
    async tryAcquire(owner) {
      if (holder === null) holder = owner;
      return { acquired: holder === owner, holder };
    },
    async release(owner) {
      if (holder !== owner) return false;
      holder = null;
      return true;
    },
    async holder() {
      return holder;
    },
    current: () => holder,
  };
}
