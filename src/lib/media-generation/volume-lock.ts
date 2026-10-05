import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// Slice 6 (PHASE_14_PLAN.md §5.2): the lock is now shared/exclusive. Generation sessions hold the volume SHARED
// simply by being active rows (any number, up to `maxConcurrentSessions`); the row below is the EXCLUSIVE hold of a
// model pull or an operator pod. Each side's write is one statement guarded by the other side's absence (the approve
// UPDATE checks "no lock row", the lock insert checks "no active session"), so AC-P14-18 stays a constraint.
//
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
  /**
   * Atomic insert-if-absent, refused while any generation session is active (slice 6: sessions hold the volume SHARED by
   * being active rows; this row is the EXCLUSIVE hold). `acquired` only when THIS call inserted the row; `holder` is
   * whoever holds the row afterwards, `null` when no row exists and `activeSessions` > 0 blocked the insert.
   */
  tryAcquire(owner: string, at: Date): Promise<{ acquired: boolean; holder: VolumeLockHolder | null; activeSessions: number }>;
  /** Removes the row only if `owner` holds it; `false` when it did not. */
  release(owner: string): Promise<boolean>;
  holder(): Promise<VolumeLockHolder | null>;
};

/** Exclusive owners (a model pull, an operator pod). `session:` survives only as a pre-slice-6 row left by a crash. */
export type VolumeLockOwner = `session:${string}` | `pull:${string}` | `pod:${string}`;

export type VolumeLock = {
  /**
   * Takes the EXCLUSIVE lock for `owner` or throws `media_session_conflict` naming the holder (or the active sessions).
   * Re-entrant for the same owner, and says which: only the call that reports "acquired" may release on its own failure
   * path (review round 15 -- a second concurrent call for the same owner must not free the lock the first relies on).
   */
  acquire(owner: VolumeLockOwner): Promise<"acquired" | "already-held">;
  release(owner: VolumeLockOwner): Promise<boolean>;
  holder(): Promise<VolumeLockHolder | null>;
  /**
   * The exclusive holder that is really there: a crash-stale row (inactive owner, older than the grace) is released and
   * `null` returned. A session approve calls this before its guarded UPDATE, so a pull that died never blocks sessions.
   */
  activeHolder(): Promise<VolumeLockHolder | null>;
};

export function describeActiveSessions(count: number): string {
  return `${count} generation session${count === 1 ? " is" : "s are"} using the network volume; stop ${count === 1 ? "it" : "them"} first (Production → Sessions).`;
}

export function describeVolumeLockHolder(holder: string): string {
  if (holder.startsWith("session:")) return `A generation session (${holder.slice("session:".length)}) is open on the network volume; stop it first (Production → Sessions).`;
  if (holder.startsWith("pull:")) return `A model pull (${holder.slice("pull:".length)}) is writing to the network volume; wait for it to finish (Production → Models).`;
  if (holder.startsWith("pod:")) return `An operator pod (${holder.slice("pod:".length)}) has the network volume mounted; terminate it first (media pod-terminate).`;
  return `The network volume is busy (${holder}).`;
}

export function createVolumeLock(deps: { store: VolumeLockStore; isHolderActive(holder: string): Promise<boolean>; clock?: { now(): Date }; log?: (line: string) => void }): VolumeLock {
  const log = deps.log ?? (() => undefined);
  const now = () => (deps.clock ?? { now: () => new Date() }).now();
  const holderConflict = (holder: VolumeLockHolder) =>
    new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(holder.owner), details: { holder: holder.owner, since: holder.since.toISOString() } });

  /** `true` = the holder is (or may still be) live; `false` = it was stale and has been released. */
  async function keepOrSteal(holder: VolumeLockHolder, forOwner: string): Promise<boolean> {
    if (await deps.isHolderActive(holder.owner)) return true;
    // Not visibly active: either its own row is not written yet (acquire precedes the write by milliseconds) or a
    // crash left it. Only age tells them apart.
    if (now().getTime() - holder.since.getTime() < VOLUME_LOCK_STALE_AFTER_MS) return true;
    log(`[media] volume lock held by inactive ${holder.owner} since ${holder.since.toISOString()}; releasing it for ${forOwner}`);
    await deps.store.release(holder.owner);
    return false;
  }

  return {
    async acquire(owner) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await deps.store.tryAcquire(owner, now());
        if (result.acquired) return "acquired";
        if (result.holder === null) {
          throw new DomainError({ code: "media_session_conflict", message: describeActiveSessions(result.activeSessions), details: { holder: null, activeSessions: result.activeSessions } });
        }
        if (result.holder.owner === owner) return "already-held";
        if (await keepOrSteal(result.holder, owner)) throw holderConflict(result.holder);
      }
      const holder = await deps.store.holder();
      throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(holder?.owner ?? "unknown"), details: { holder: holder?.owner ?? null } });
    },
    release: (owner) => deps.store.release(owner),
    holder: () => deps.store.holder(),
    async activeHolder() {
      const holder = await deps.store.holder();
      if (!holder) return null;
      return (await keepOrSteal(holder, "a session approve")) ? holder : null;
    },
  };
}

/**
 * An in-memory store with the same atomic semantics (tests, and the only other legitimate use: a dry-run core).
 * `activeSessions` stands in for the database's "no active session" guard on the insert.
 */
export function createMemoryVolumeLockStore(opts: { activeSessions?: () => number } = {}): VolumeLockStore & { current: () => string | null } {
  let holder: VolumeLockHolder | null = null;
  return {
    async tryAcquire(owner, at) {
      if (holder === null) {
        const activeSessions = opts.activeSessions?.() ?? 0;
        if (activeSessions > 0) return { acquired: false, holder: null, activeSessions };
        holder = { owner, since: at };
        return { acquired: true, holder, activeSessions: 0 };
      }
      return { acquired: false, holder, activeSessions: 0 };
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
