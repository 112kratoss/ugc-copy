/**
 * The web's feed telemetry outbox: every batched event this browser queued and
 * has not seen acknowledged, kept in localStorage beside the page's own queue
 * (`ShowcaseFeedInteraction.tsx`). A batch waits up to 15 s for company, and a
 * tab that crashes or is killed in that time fires no `pagehide` to send it, so
 * a later page of the same viewer sends what such a page left. The app's queue
 * keeps its events on the device for the same reason (`ugc-mobile/lib/feed-event-queue.ts`).
 *
 * No token is stored: an entry names its viewer (`user:<id>`, or `anonymous`
 * for a visitor the feed cookie identifies) and is sent only with a token of
 * that viewer. The server records an event once by its `clientEventId`, so an
 * entry sent twice (a page killed after its request left) is recorded once.
 */

export const FEED_EVENT_OUTBOX_STORAGE_KEY = 'magicbooklet.feedEvents.outbox.v1';
/** The server refuses an event older than a day (`MAX_EVENT_AGE_MS`). */
export const FEED_EVENT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const FEED_EVENT_OUTBOX_MAX_ENTRIES = 200;
/**
 * A live page sends its own events within the batching window and hears the
 * answer seconds later, so only entries older than this are another page's to
 * send: one that died, or one whose send failed and let them go.
 */
export const FEED_EVENT_OUTBOX_ADOPT_AFTER_MS = 60_000;

export type FeedEventOutboxEntry = {
  /** The event's `clientEventId`. */
  id: string;
  /** `user:<id>` or `anonymous`. */
  identity: string;
  /** The page sending it; empty once a failed send let it go. */
  owner: string;
  queuedAt: number;
  body: Record<string, unknown>;
};

export type FeedEventOutboxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

/**
 * Whose event this is, read from the bearer token it is queued with (the
 * token's `sub`, never the token). Null when a token cannot be read: such an
 * event stays in the page's memory only, as every event did before.
 */
export function feedEventIdentity(accessToken: string | null | undefined): string | null {
  if (!accessToken) return 'anonymous';
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    return isRecord(claims) && typeof claims.sub === 'string' && claims.sub ? `user:${claims.sub}` : null;
  } catch {
    return null;
  }
}

function isOutboxEntry(value: unknown): value is FeedEventOutboxEntry {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.identity === 'string' && value.identity.length > 0
    && typeof value.owner === 'string'
    && typeof value.queuedAt === 'number' && Number.isFinite(value.queuedAt)
    && isRecord(value.body)
    && value.body.clientEventId === value.id;
}

/** What the outbox holds that the server would still take, oldest first. */
export function readFeedEventOutbox(storage: FeedEventOutboxStorage, now: number): FeedEventOutboxEntry[] {
  let parsed: unknown = null;
  try {
    const raw = storage.getItem(FEED_EVENT_OUTBOX_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
  return parsed.entries
    .filter(isOutboxEntry)
    .filter((entry) => now - entry.queuedAt <= FEED_EVENT_OUTBOX_MAX_AGE_MS)
    .slice(-FEED_EVENT_OUTBOX_MAX_ENTRIES);
}

/** Never throws: storage that is full, blocked or gone leaves the page's memory to carry the events. */
export function writeFeedEventOutbox(storage: FeedEventOutboxStorage, entries: FeedEventOutboxEntry[]) {
  try {
    if (entries.length === 0) storage.removeItem(FEED_EVENT_OUTBOX_STORAGE_KEY);
    else storage.setItem(FEED_EVENT_OUTBOX_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: entries.slice(-FEED_EVENT_OUTBOX_MAX_ENTRIES),
    }));
  } catch {
    // Telemetry: the in-memory queue still sends what this page made.
  }
}

/**
 * Claims, for `owner`, the entries of `identity` no live page is sending: older
 * than `FEED_EVENT_OUTBOX_ADOPT_AFTER_MS` and not already its own. Returns them
 * with the time each was queued as its `occurredAt`, since the server would
 * otherwise stamp an event sent this late with the time it arrived.
 */
export function adoptFeedEventOutboxEntries(
  storage: FeedEventOutboxStorage,
  { identity, owner, now }: { identity: string; owner: string; now: number },
): Array<{ queuedAt: number; body: Record<string, unknown> }> {
  const entries = readFeedEventOutbox(storage, now);
  const adopted: FeedEventOutboxEntry[] = [];
  const next = entries.map((entry) => {
    if (
      entry.identity !== identity
      || entry.owner === owner
      || now - entry.queuedAt < FEED_EVENT_OUTBOX_ADOPT_AFTER_MS
    ) return entry;
    adopted.push(entry);
    return { ...entry, owner };
  });
  if (adopted.length === 0) return [];
  writeFeedEventOutbox(storage, next);
  return adopted.map((entry) => ({
    queuedAt: entry.queuedAt,
    body: { ...entry.body, occurredAt: new Date(entry.queuedAt).toISOString() },
  }));
}
