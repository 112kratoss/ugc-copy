import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const loggerMocks = vi.hoisted(() => ({ logBackendWarning: vi.fn() }));

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-logger')>()),
  logBackendWarning: loggerMocks.logBackendWarning,
}));

import { recordPostResourceBundlePurchaseFeedEvent } from '@/lib/post-resource-bundle-order-service';
import {
  AUTHORITATIVE_FEED_EVENT_SOURCE_SURFACE,
  AUTHORITATIVE_FEED_EVENT_TYPES,
  parseFeedDeliveryIdField,
  parseShowcaseFeedEventPayload,
  recordAuthoritativeFeedEvent,
  scheduleAuthoritativeFeedEvent,
} from '@/lib/showcase-feed-events-service';

type Row = Record<string, unknown>;

const VIEWER = '10000000-0000-4000-8000-000000000001';
const OTHER_VIEWER = '10000000-0000-4000-8000-000000000002';
const CREATOR = '20000000-0000-4000-8000-000000000001';
const POST = '30000000-0000-4000-8000-000000000001';
const OTHER_POST = '30000000-0000-4000-8000-000000000002';
const SESSION = '40000000-0000-4000-8000-000000000001';
const OTHER_SESSION = '40000000-0000-4000-8000-000000000002';

/**
 * An in-memory stand-in for the four tables the writer touches. Reads apply
 * the filters the code sends; inserts enforce the two unique indexes the real
 * table has (`client_event_id`, and one event of a type per delivery).
 */
function feedTables(seed: {
  posts?: Row[];
  feed_session_items?: Row[];
  feed_sessions?: Row[];
  feed_events?: Row[];
  post_resource_bundle_orders?: Row[];
} = {}, options: { insert?: (row: Row) => Promise<{ error: unknown }> | null } = {}) {
  const tables: Record<string, Row[]> = {
    post_resource_bundle_orders: seed.post_resource_bundle_orders ?? [],
    posts: seed.posts ?? [{ id: POST, user_id: CREATOR, visibility: 'public', archived_at: null }],
    feed_session_items: seed.feed_session_items ?? [
      { id: 501, session_id: SESSION, post_id: POST, position: 4 },
      { id: 502, session_id: OTHER_SESSION, post_id: POST, position: 1 },
      { id: 503, session_id: SESSION, post_id: OTHER_POST, position: 5 },
    ],
    feed_sessions: seed.feed_sessions ?? [
      { id: SESSION, viewer_user_id: VIEWER, created_at: '2026-10-01T08:00:00.000Z' },
      { id: OTHER_SESSION, viewer_user_id: OTHER_VIEWER, created_at: '2026-10-01T08:00:00.000Z' },
    ],
    feed_events: seed.feed_events ?? [],
  };
  const reads: string[] = [];

  function from(table: string) {
    reads.push(table);
    const filters: Array<(row: Row) => boolean> = [];
    let ordering: { column: string; ascending: boolean } | null = null;
    const query = {
      select: () => query,
      eq(column: string, value: unknown) {
        filters.push((row) => String(row[column]) === String(value));
        return query;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      not(column: string, operator: string, value: unknown) {
        if (operator === 'is' && value === null) filters.push((row) => row[column] !== null && row[column] !== undefined);
        return query;
      },
      gte(column: string, value: string) {
        filters.push((row) => String(row[column]) >= value);
        return query;
      },
      order(column: string, { ascending }: { ascending: boolean }) {
        ordering = { column, ascending };
        return query;
      },
      limit: () => query,
      async maybeSingle() {
        const rows = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        if (ordering) {
          const { column, ascending } = ordering;
          rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) * (ascending ? 1 : -1));
        }
        return { data: rows[0] ?? null, error: null };
      },
      insert(row: Row) {
        const custom = options.insert?.(row);
        if (custom) return custom;
        const events = tables.feed_events;
        const conflict = events.some((event) => event.client_event_id === row.client_event_id)
          || (row.session_item_id !== null && events.some((event) => (
            event.session_item_id === row.session_item_id && event.event_type === row.event_type
          )));
        if (conflict) return Promise.resolve({ error: { code: '23505', message: 'duplicate key value' } });
        events.push(row);
        return Promise.resolve({ error: null });
      },
    };
    return query;
  }

  return { client: { from } as unknown as SupabaseClient, tables, reads };
}

afterEach(() => {
  loggerMocks.logBackendWarning.mockClear();
  vi.useRealTimers();
});

describe('recordAuthoritativeFeedEvent', () => {
  it('writes the event a client may not, attributed to a delivery of the post to the viewer', async () => {
    const db = feedTables();

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      occurredAt: '2026-10-01T09:00:00.000Z',
    });

    expect(result).toEqual({ status: 'recorded', deliveryId: '501' });
    expect(db.tables.feed_events).toEqual([{
      client_event_id: `srv:comment:${VIEWER}:${POST}:501`,
      session_id: SESSION,
      session_item_id: '501',
      viewer_user_id: VIEWER,
      anonymous_key_hash: null,
      post_id: POST,
      creator_user_id: CREATOR,
      event_type: 'comment',
      source_surface: AUTHORITATIVE_FEED_EVENT_SOURCE_SURFACE,
      position: 4,
      duration_ms: null,
      progress: null,
      metadata: {},
      occurred_at: '2026-10-01T09:00:00.000Z',
    }]);
  });

  // The post-report route writes it: the delivery it carries is what stamps
  // that delivery fact's `reported_at` (`apply_feed_delivery_outcome`).
  it('writes a report against the delivery it was filed from', async () => {
    const db = feedTables();

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'report',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      occurredAt: '2026-10-01T09:00:00.000Z',
    });

    expect(result).toEqual({ status: 'recorded', deliveryId: '501' });
    expect(db.tables.feed_events).toEqual([expect.objectContaining({
      client_event_id: `srv:report:${VIEWER}:${POST}:501`,
      session_id: SESSION,
      session_item_id: '501',
      event_type: 'report',
      source_surface: AUTHORITATIVE_FEED_EVENT_SOURCE_SURFACE,
      position: 4,
    })]);
  });

  it.each([
    ['another viewer\'s delivery', '502'],
    ['a delivery of another post', '503'],
    ['a delivery that no longer exists', '599'],
    ['a malformed delivery id', 'not-a-number'],
  ])('keeps the action but drops %s', async (_label, deliveryId) => {
    const db = feedTables();

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'follow',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId,
      occurredAt: '2026-10-01T09:00:00.000Z',
    });

    expect(result).toEqual({ status: 'recorded', deliveryId: null });
    expect(db.tables.feed_events).toHaveLength(1);
    expect(db.tables.feed_events[0]).toMatchObject({
      session_id: null,
      session_item_id: null,
      position: null,
      client_event_id: `srv:follow:${VIEWER}:${POST}:-`,
    });
  });

  it('drops a delivery from a session that began after the action', async () => {
    const db = feedTables();

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      occurredAt: '2026-10-01T07:59:00.000Z',
    });

    expect(result).toEqual({ status: 'recorded', deliveryId: null });
  });

  it('writes each action once: a retried action is a duplicate', async () => {
    const db = feedTables();
    const input = {
      eventType: 'comment' as const,
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      occurredAt: '2026-10-01T09:00:00.000Z',
    };

    await expect(recordAuthoritativeFeedEvent(db.client, input)).resolves.toEqual({ status: 'recorded', deliveryId: '501' });
    // A second comment from the same card is the same signal.
    await expect(recordAuthoritativeFeedEvent(db.client, { ...input, occurredAt: '2026-10-01T09:05:00.000Z' }))
      .resolves.toEqual({ status: 'duplicate', deliveryId: '501' });
    await expect(recordAuthoritativeFeedEvent(db.client, { ...input, deliveryId: null }))
      .resolves.toEqual({ status: 'recorded', deliveryId: null });
    await expect(recordAuthoritativeFeedEvent(db.client, { ...input, deliveryId: null }))
      .resolves.toEqual({ status: 'duplicate', deliveryId: null });
    expect(db.tables.feed_events).toHaveLength(2);
  });

  it('reports no duplicate when the server id is held by another event: the signal is not dropped silently', async () => {
    // A client claimed the ids before the parser reserved them: same post,
    // another viewer and type.
    const claimed = (clientEventId: string, sessionItemId: string | null) => ({
      client_event_id: clientEventId,
      session_item_id: sessionItemId,
      viewer_user_id: OTHER_VIEWER,
      post_id: POST,
      event_type: 'save',
    });
    const db = feedTables({
      feed_events: [
        claimed(`srv:follow:${VIEWER}:${POST}:-`, null),
        claimed(`srv:comment:${VIEWER}:${POST}:501`, '502'),
      ],
    });

    // Without a delivery: the client event id is the only key that conflicts.
    await expect(recordAuthoritativeFeedEvent(db.client, {
      eventType: 'follow',
      viewerUserId: VIEWER,
      postId: POST,
      occurredAt: '2026-10-01T09:00:00.000Z',
    })).resolves.toEqual({ status: 'failed', reason: 'error' });
    // With one: neither attributed nor retried without it.
    await expect(recordAuthoritativeFeedEvent(db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      occurredAt: '2026-10-01T09:00:00.000Z',
    })).resolves.toEqual({ status: 'failed', reason: 'error' });

    expect(db.tables.feed_events).toHaveLength(2);
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledTimes(2);
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('authoritative_feed_event_failed', expect.objectContaining({
      eventType: 'follow',
      error: new Error('Feed event ID is already used by a different event'),
    }));
  });

  it('is a duplicate only of the same action: same type, viewer and post', async () => {
    const write = (eventType: 'comment' | 'follow', viewerUserId: string) => recordAuthoritativeFeedEvent(feedTables({
      feed_events: [{
        client_event_id: `srv:${eventType}:same-key`,
        session_item_id: null,
        viewer_user_id: VIEWER,
        post_id: POST,
        event_type: 'comment',
      }],
    }).client, { eventType, viewerUserId, postId: POST, actionKey: 'same-key', occurredAt: '2026-10-01T09:00:00.000Z' });

    await expect(write('comment', VIEWER)).resolves.toEqual({ status: 'duplicate', deliveryId: null });
    await expect(write('follow', VIEWER)).resolves.toEqual({ status: 'failed', reason: 'error' });
    await expect(write('comment', OTHER_VIEWER)).resolves.toEqual({ status: 'failed', reason: 'error' });
  });

  it('writes a second action from a delivery already credited without the delivery', async () => {
    const db = feedTables();
    const remix = (generationId: string) => recordAuthoritativeFeedEvent(db.client, {
      eventType: 'remix_complete',
      viewerUserId: VIEWER,
      postId: POST,
      deliveryId: '501',
      actionKey: generationId,
      occurredAt: '2026-10-01T09:00:00.000Z',
    });

    await expect(remix('generation-1')).resolves.toEqual({ status: 'recorded', deliveryId: '501' });
    await expect(remix('generation-2')).resolves.toEqual({ status: 'recorded', deliveryId: null });
    await expect(remix('generation-2')).resolves.toEqual({ status: 'duplicate', deliveryId: null });
    expect(db.tables.feed_events.map((event) => [event.client_event_id, event.session_item_id])).toEqual([
      ['srv:remix_complete:generation-1', '501'],
      ['srv:remix_complete:generation-2', null],
    ]);
  });

  it('credits the delivery of the viewer\'s latest matching event in the window', async () => {
    const db = feedTables({
      feed_events: [
        // Too old, another viewer, another type: none of these.
        { client_event_id: 'a', viewer_user_id: VIEWER, post_id: POST, event_type: 'remix_start', session_item_id: 999, occurred_at: '2026-09-28T09:00:00.000Z' },
        { client_event_id: 'b', viewer_user_id: OTHER_VIEWER, post_id: POST, event_type: 'remix_start', session_item_id: 502, occurred_at: '2026-10-01T08:50:00.000Z' },
        { client_event_id: 'c', viewer_user_id: VIEWER, post_id: POST, event_type: 'open', session_item_id: 777, occurred_at: '2026-10-01T08:55:00.000Z' },
        { client_event_id: 'd', viewer_user_id: VIEWER, post_id: POST, event_type: 'remix_start', session_item_id: 501, occurred_at: '2026-10-01T08:30:00.000Z' },
      ],
    });

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'remix_complete',
      viewerUserId: VIEWER,
      postId: POST,
      actionKey: 'generation-1',
      occurredAt: '2026-10-01T09:00:00.000Z',
      inferDeliveryFrom: { eventTypes: ['remix_start'], withinHours: 48 },
    });

    expect(result).toEqual({ status: 'recorded', deliveryId: '501' });
  });

  it('finds the post through the delivery when the caller only has the delivery', async () => {
    const db = feedTables();

    await expect(recordAuthoritativeFeedEvent(db.client, {
      eventType: 'follow',
      viewerUserId: VIEWER,
      deliveryId: '501',
      expectedCreatorUserId: CREATOR,
      occurredAt: '2026-10-01T09:00:00.000Z',
    })).resolves.toEqual({ status: 'recorded', deliveryId: '501' });
    expect(db.tables.feed_events[0]).toMatchObject({ post_id: POST, event_type: 'follow' });
  });

  it.each([
    ['a post that is not public', { posts: [{ id: POST, user_id: CREATOR, visibility: 'unlisted', archived_at: null }] }, {}, 'post_unavailable'],
    ['an archived post', { posts: [{ id: POST, user_id: CREATOR, visibility: 'public', archived_at: '2026-10-01T00:00:00.000Z' }] }, {}, 'post_unavailable'],
    ['a missing post', { posts: [] }, {}, 'post_unavailable'],
    ['the creator acting on their own post', {}, { viewerUserId: CREATOR }, 'self_engagement'],
    ['a follow of someone else credited to this post', {}, { expectedCreatorUserId: OTHER_VIEWER }, 'creator_mismatch'],
    ['a malformed viewer', {}, { viewerUserId: 'nobody' }, 'invalid_input'],
    ['no post and no delivery', {}, { postId: null }, 'invalid_input'],
    ['an event type a client sends', {}, { eventType: 'save' }, 'invalid_input'],
  ] as const)('writes nothing for %s', async (_label, seed, overrides, reason) => {
    const db = feedTables(seed as Parameters<typeof feedTables>[0]);

    const result = await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'follow',
      viewerUserId: VIEWER,
      postId: POST,
      ...(overrides as Record<string, unknown>),
    } as Parameters<typeof recordAuthoritativeFeedEvent>[1]);

    expect(result).toEqual({ status: 'skipped', reason });
    expect(db.tables.feed_events).toEqual([]);
  });

  it('never stamps an event in the future', async () => {
    const db = feedTables();
    const before = Date.now();

    await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'purchase',
      viewerUserId: VIEWER,
      postId: POST,
      occurredAt: new Date(before + 3_600_000),
    });

    expect(Date.parse(String(db.tables.feed_events[0].occurred_at))).toBeLessThanOrEqual(Date.now());
  });

  it('hashes an action key that would not fit the client event id', async () => {
    const db = feedTables();

    await recordAuthoritativeFeedEvent(db.client, {
      eventType: 'remix_complete',
      viewerUserId: VIEWER,
      postId: POST,
      actionKey: 'k'.repeat(200),
    });

    const id = String(db.tables.feed_events[0].client_event_id);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^srv:remix_complete:[0-9a-f]{64}$/);
  });

  it('never throws: a failing write is reported, logged and swallowed', async () => {
    const db = feedTables({}, {
      insert: () => Promise.resolve({ error: { code: '42501', message: 'permission denied' } }),
    });

    await expect(recordAuthoritativeFeedEvent(db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
    })).resolves.toEqual({ status: 'failed', reason: 'error' });
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('authoritative_feed_event_failed', expect.objectContaining({
      eventType: 'comment',
    }));

    const throwing = { from: () => { throw new Error('client exploded'); } } as unknown as SupabaseClient;
    await expect(recordAuthoritativeFeedEvent(throwing, {
      eventType: 'follow',
      viewerUserId: VIEWER,
      postId: POST,
    })).resolves.toEqual({ status: 'failed', reason: 'error' });
  });

  it('gives up after its timeout, so the action is never held', async () => {
    const db = feedTables({}, { insert: () => new Promise(() => {}) });
    const startedAt = Date.now();

    await expect(recordAuthoritativeFeedEvent(db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
      timeoutMs: 25,
    })).resolves.toEqual({ status: 'failed', reason: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(loggerMocks.logBackendWarning).toHaveBeenCalledWith('authoritative_feed_event_timed_out', expect.objectContaining({
      eventType: 'comment',
      timeoutMs: 25,
    }));
  });

  it('keeps the server\'s event ids to the server: the client parser refuses a srv: id', () => {
    for (const clientEventId of [`srv:follow:${VIEWER}:${POST}:-`, 'SRV:comment:x', 'Srv:anything']) {
      expect(parseShowcaseFeedEventPayload({
        clientEventId,
        postId: POST,
        eventType: 'open',
        sourceSurface: 'feed',
      })).toEqual({ ok: false, status: 400, body: { error: 'Feed event ID uses a prefix reserved for the server.' } });
    }
    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'client:srv:open',
      postId: POST,
      eventType: 'open',
      sourceSurface: 'feed',
    }).ok).toBe(true);
  });

  it('keeps the five types server-only: the client parser refuses every one', () => {
    expect(AUTHORITATIVE_FEED_EVENT_TYPES).toEqual(['comment', 'follow', 'remix_complete', 'purchase', 'report']);
    for (const eventType of AUTHORITATIVE_FEED_EVENT_TYPES) {
      const parsed = parseShowcaseFeedEventPayload({
        clientEventId: 'event-1',
        postId: POST,
        eventType,
        sourceSurface: 'feed',
      });
      // `comment` is not a client type at all; the other four are refused when
      // recorded (recordShowcaseFeedEvent and the batch RPC answer 400).
      if (eventType === 'comment') expect(parsed.ok).toBe(false);
    }
  });
});

describe('recordPostResourceBundlePurchaseFeedEvent', () => {
  const order = {
    razorpay_order_id: 'order_bundle_1',
    buyer_user_id: VIEWER,
    post_resource_bundles: { post_id: POST },
  };

  it('reads the buyer and the post from the order, and credits the resources the buyer opened', async () => {
    const db = feedTables({
      post_resource_bundle_orders: [order],
      feed_events: [
        { client_event_id: 'opened', viewer_user_id: VIEWER, post_id: POST, event_type: 'resource_open', session_item_id: 501, occurred_at: new Date(Date.now() - 600_000).toISOString() },
      ],
      feed_sessions: [{ id: SESSION, viewer_user_id: VIEWER, created_at: new Date(Date.now() - 3_600_000).toISOString() }],
    });

    await expect(recordPostResourceBundlePurchaseFeedEvent(db.client, { razorpayOrderId: 'order_bundle_1' }))
      .resolves.toEqual({ status: 'recorded', deliveryId: '501' });
    expect(db.tables.feed_events.at(-1)).toMatchObject({
      client_event_id: `srv:purchase:${VIEWER}:${POST}`,
      event_type: 'purchase',
      viewer_user_id: VIEWER,
      creator_user_id: CREATOR,
      session_item_id: '501',
    });
  });

  it('is one event however many settlement paths report the purchase', async () => {
    const db = feedTables({ post_resource_bundle_orders: [order] });

    // The buyer's verify, then Razorpay's webhook, then a store settlement.
    await expect(recordPostResourceBundlePurchaseFeedEvent(db.client, { razorpayOrderId: 'order_bundle_1' }))
      .resolves.toEqual({ status: 'recorded', deliveryId: null });
    await expect(recordPostResourceBundlePurchaseFeedEvent(db.client, { razorpayOrderId: 'order_bundle_1' }))
      .resolves.toEqual({ status: 'duplicate', deliveryId: null });
    await expect(recordPostResourceBundlePurchaseFeedEvent(db.client, { buyerUserId: VIEWER, postId: POST }))
      .resolves.toEqual({ status: 'duplicate', deliveryId: null });
    expect(db.tables.feed_events).toHaveLength(1);
  });

  it('writes nothing for an order it cannot read, and never throws', async () => {
    await expect(recordPostResourceBundlePurchaseFeedEvent(feedTables().client, { razorpayOrderId: 'missing' }))
      .resolves.toEqual({ status: 'skipped', reason: 'invalid_input' });

    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }),
      }),
    } as unknown as SupabaseClient;
    await expect(recordPostResourceBundlePurchaseFeedEvent(failing, { razorpayOrderId: 'order_bundle_1' }))
      .resolves.toEqual({ status: 'failed', reason: 'error' });

    const hanging = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => {}) }) }) }),
    } as unknown as SupabaseClient;
    await expect(recordPostResourceBundlePurchaseFeedEvent(hanging, { razorpayOrderId: 'order_bundle_1' }, { timeoutMs: 20 }))
      .resolves.toEqual({ status: 'failed', reason: 'timeout' });
  });
});

describe('parseFeedDeliveryIdField', () => {
  it('reads a delivery id as the clients send it, and nothing else', () => {
    expect(parseFeedDeliveryIdField('501')).toBe('501');
    expect(parseFeedDeliveryIdField(' 501 ')).toBe('501');
    expect(parseFeedDeliveryIdField(501)).toBe('501');
    expect(parseFeedDeliveryIdField('9223372036854775807')).toBe('9223372036854775807');
    for (const value of [undefined, null, '', '0', '-3', '1.5', 'abc', '9223372036854775808', 0, -1, 1.5, Number.NaN, {}, true]) {
      expect(parseFeedDeliveryIdField(value)).toBeNull();
    }
  });
});

describe('scheduleAuthoritativeFeedEvent', () => {
  it('hands the write to the scheduler, so the answer goes first', async () => {
    const db = feedTables();
    const deferred: Array<() => Promise<unknown>> = [];

    await scheduleAuthoritativeFeedEvent((task) => { deferred.push(task); }, db.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
    });

    expect(db.tables.feed_events).toEqual([]);
    expect(deferred).toHaveLength(1);
    await deferred[0]();
    expect(db.tables.feed_events).toHaveLength(1);
  });

  it('writes before returning when there is no scheduler, or the scheduler refuses', async () => {
    const inline = feedTables();
    await scheduleAuthoritativeFeedEvent(undefined, inline.client, { eventType: 'comment', viewerUserId: VIEWER, postId: POST });
    expect(inline.tables.feed_events).toHaveLength(1);

    const refused = feedTables();
    await scheduleAuthoritativeFeedEvent(() => { throw new Error('outside a request'); }, refused.client, {
      eventType: 'comment',
      viewerUserId: VIEWER,
      postId: POST,
    });
    expect(refused.tables.feed_events).toHaveLength(1);
  });
});
