import 'server-only';

/**
 * How long one server instance keeps the feed's configuration rows (the
 * algorithm version a page is ranked with, the running experiment) before it
 * reads them again. Every ranked For you page read both, and on a database
 * idle for more than half a minute each read cost 300-600 ms instead of
 * 30-50 ms (perf loop 2026-11-24). An activation, a rollback, a kill switch or
 * an experiment start or stop therefore reaches new feed sessions within this
 * long of the change, not at once (`docs/feed-algorithm-operations.md`).
 */
export const FEED_CONFIG_CACHE_TTL_MS = 60_000;

type Entry<T> = { expiresAt: number; value: Promise<T> };

/**
 * A per-instance cache of configuration reads, held per database client (the
 * service client is one per instance, `createServiceClient`), so a client
 * never reads a row another client loaded. Two reads that ask at once share one
 * round trip. Only a read that answered is kept: a load that throws is
 * forgotten at once, and the next request reads again.
 */
export function createFeedConfigCache<T>(ttlMs = FEED_CONFIG_CACHE_TTL_MS) {
  let entriesByClient = new WeakMap<object, Map<string, Entry<T>>>();
  return {
    read(client: object, key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
      let entries = entriesByClient.get(client);
      if (!entries) {
        entries = new Map();
        entriesByClient.set(client, entries);
      }
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now) return cached.value;
      const value = load();
      const entry: Entry<T> = { expiresAt: now + ttlMs, value };
      entries.set(key, entry);
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
    clear() {
      entriesByClient = new WeakMap();
    },
  };
}
