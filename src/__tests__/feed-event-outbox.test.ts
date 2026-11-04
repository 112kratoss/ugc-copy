import { afterEach, describe, expect, it } from 'vitest';

import {
  FEED_EVENT_OUTBOX_ADOPT_AFTER_MS,
  FEED_EVENT_OUTBOX_MAX_AGE_MS,
  FEED_EVENT_OUTBOX_STORAGE_KEY,
  adoptFeedEventOutboxEntries,
  feedEventIdentity,
  readFeedEventOutbox,
  writeFeedEventOutbox,
  type FeedEventOutboxEntry,
} from '@/app/showcase/feed-event-outbox';

function tokenFor(claims: Record<string, unknown>) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'ES256' })}.${encode(claims)}.signature`;
}

function entry(id: string, overrides: Partial<FeedEventOutboxEntry> = {}): FeedEventOutboxEntry {
  return {
    id,
    identity: 'user:user-1',
    owner: 'page-a',
    queuedAt: 1_700_000_000_000,
    body: { clientEventId: id, eventType: 'impression', postId: 'post-1' },
    ...overrides,
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('feed event outbox', () => {
  it("names an event's viewer from its token, never keeping the token", () => {
    expect(feedEventIdentity(tokenFor({ sub: 'user-1', exp: 1 }))).toBe('user:user-1');
    expect(feedEventIdentity(null)).toBe('anonymous');
    // A token it cannot read keeps its event in the page's memory only.
    expect(feedEventIdentity('token-1')).toBeNull();
    expect(feedEventIdentity(tokenFor({ exp: 1 }))).toBeNull();
    expect(feedEventIdentity('a.%%%.c')).toBeNull();
  });

  it('reads back what it wrote, dropping what the server would refuse and what it cannot parse', () => {
    const now = 1_700_000_000_000;
    writeFeedEventOutbox(window.localStorage, [
      entry('old', { queuedAt: now - FEED_EVENT_OUTBOX_MAX_AGE_MS - 1 }),
      entry('kept', { queuedAt: now - 1_000 }),
      { ...entry('mismatched'), body: { clientEventId: 'another' } },
    ]);
    expect(readFeedEventOutbox(window.localStorage, now).map(({ id }) => id)).toEqual(['kept']);

    window.localStorage.setItem(FEED_EVENT_OUTBOX_STORAGE_KEY, '{not json');
    expect(readFeedEventOutbox(window.localStorage, now)).toEqual([]);

    writeFeedEventOutbox(window.localStorage, []);
    expect(window.localStorage.getItem(FEED_EVENT_OUTBOX_STORAGE_KEY)).toBeNull();
  });

  it("hands a page only its viewer's entries that no live page is sending, with their time", () => {
    const now = 1_700_000_000_000;
    const old = now - FEED_EVENT_OUTBOX_ADOPT_AFTER_MS;
    writeFeedEventOutbox(window.localStorage, [
      entry('dead-page', { owner: 'page-a', queuedAt: old }),
      entry('let-go', { owner: '', queuedAt: old }),
      entry('live-page', { owner: 'page-c', queuedAt: now - 5_000 }),
      entry('mine', { owner: 'page-b', queuedAt: old }),
      entry('someone-else', { identity: 'user:user-2', queuedAt: old }),
    ]);

    const adopted = adoptFeedEventOutboxEntries(window.localStorage, { identity: 'user:user-1', owner: 'page-b', now });

    expect(adopted.map(({ body }) => body.clientEventId)).toEqual(['dead-page', 'let-go']);
    expect(adopted[0].body.occurredAt).toBe(new Date(old).toISOString());
    // Claimed, so another tab does not send them too.
    expect(readFeedEventOutbox(window.localStorage, now).map(({ id, owner }) => [id, owner])).toEqual([
      ['dead-page', 'page-b'],
      ['let-go', 'page-b'],
      ['live-page', 'page-c'],
      ['mine', 'page-b'],
      ['someone-else', 'page-a'],
    ]);
    expect(adoptFeedEventOutboxEntries(window.localStorage, { identity: 'user:user-1', owner: 'page-b', now })).toEqual([]);
  });
});
