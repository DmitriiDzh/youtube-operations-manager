/**
 * BL-197: a per-user value remembered for a fixed time, shared by the header's live channel (`channel-access/live-channel-memo.ts`) and
 * the playlist pickers' list (`playlist-management/playlist-list-memo.ts`).
 *
 * A live read that started before a `forget` must not put its older answer back: `epoch(userId)` is taken before the read and
 * `remember` drops the value when a `forget` happened since (review of BL-197).
 *
 * Kept on `globalThis` under a `Symbol.for` key: Next.js bundles route handlers and the auth callbacks separately, and every copy must
 * see the same memo (the BL-116 lesson).
 */

export type UserTtlMemo<T> = {
  recall(userId: string, now?: Date): T | null;
  /** The value of the user's forget counter; pass it to `remember` for a read that started now. */
  epoch(userId: string): number;
  remember(userId: string, value: T, epoch: number, now?: Date): void;
  forget(userId: string): void;
};

type State<T> = { entries: Map<string, { value: T; readAt: number }>; epochs: Map<string, number> };

export function createUserTtlMemo<T>(symbolKey: string, ttlMs: number): UserTtlMemo<T> {
  const key = Symbol.for(symbolKey);
  const state = (): State<T> => {
    const g = globalThis as unknown as Record<symbol, State<T> | undefined>;
    return (g[key] ??= { entries: new Map(), epochs: new Map() });
  };
  return {
    recall(userId, now = new Date()) {
      const entry = state().entries.get(userId);
      if (!entry) return null;
      if (now.getTime() - entry.readAt >= ttlMs) {
        state().entries.delete(userId);
        return null;
      }
      return entry.value;
    },
    epoch: (userId) => state().epochs.get(userId) ?? 0,
    remember(userId, value, epoch, now = new Date()) {
      if ((state().epochs.get(userId) ?? 0) !== epoch) return;
      state().entries.set(userId, { value, readAt: now.getTime() });
    },
    forget(userId) {
      const s = state();
      s.entries.delete(userId);
      s.epochs.set(userId, (s.epochs.get(userId) ?? 0) + 1);
    },
  };
}
