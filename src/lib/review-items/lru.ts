// BL-272 (review): a small least-recently-used map -- the review files' SHA-256 cache keeps the entries the owner's screens read
// again and drops the one unused longest, never the whole cache at once (a clear-all re-hashed every pending file after an overflow).

export type LruCache<V> = { get(key: string): V | undefined; set(key: string, value: V): void; readonly size: number; keys(): string[] };

/** At most `max` entries; a `get` hit or a `set` makes the key the most recent, an overflow evicts the least recent. */
export function createLruCache<V>(max: number): LruCache<V> {
  const map = new Map<string, V>();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next().value as string;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}
