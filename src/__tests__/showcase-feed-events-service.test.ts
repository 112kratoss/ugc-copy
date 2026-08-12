import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  recordShowcaseFeedEvent,
  recordShowcaseFeedEvents,
  type ShowcaseFeedEventPayload,
} from '@/lib/showcase-feed-events-service';

type ExistingEvent = {
  post_id: string;
  creator_user_id: string;
  event_type: ShowcaseFeedEventPayload['eventType'];
  source_surface: string;
  viewer_user_id: string | null;
  anonymous_key_hash: string | null;
};

function payload(overrides: Partial<ShowcaseFeedEventPayload> = {}): ShowcaseFeedEventPayload {
  return {
    clientEventId: 'event-1',
    feedSessionId: null,
    deliveryId: null,
    postId: 'post-1',
    eventType: 'not_interested',
    position: 0,
    durationMs: null,
    progress: null,
    sourceSurface: 'showcase',
    occurredAt: '2026-07-11T08:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function createServiceClient({
  existingEvents = [null],
  eventInsertError = null,
  postSaved = false,
  rpcError = null,
}: {
  existingEvents?: Array<ExistingEvent | null>;
  eventInsertError?: { code: string } | null;
  postSaved?: boolean;
  rpcError?: { code: string } | null;
} = {}) {
  const operations: string[] = [];
  const feedbackUpsert = vi.fn(async () => {
    operations.push('feedback-upsert');
    return { error: null };
  });
  const eventInsert = vi.fn(async () => {
    operations.push('event-insert');
    return { error: eventInsertError };
  });
  const rpc = vi.fn(async () => {
    operations.push('rpc');
    return { error: rpcError };
  });
  let existingRead = 0;

  const from = vi.fn((table: string) => {
    if (table === 'posts') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: {
            id: 'post-1',
            user_id: 'creator-1',
            visibility: 'public',
            archived_at: null,
          },
          error: null,
        }),
      };
      return query;
    }

    if (table === 'feed_events') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: existingEvents[Math.min(existingRead++, existingEvents.length - 1)] ?? null,
          error: null,
        }),
        insert: eventInsert,
      };
      return query;
    }

    if (table === 'feed_session_items') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: { id: 'delivery-1', session_id: 'session-1', post_id: 'post-1', position: 0 },
          error: null,
        }),
      };
      return query;
    }

    if (table === 'feed_sessions') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: {
            id: 'session-1',
            viewer_user_id: 'viewer-1',
            anonymous_key_hash: null,
            created_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
          error: null,
        }),
      };
      return query;
    }

    if (table === 'post_saves') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: postSaved ? { post_id: 'post-1' } : null,
          error: null,
        }),
      };
      return query;
    }

    if (table === 'feed_user_post_feedback' || table === 'feed_user_creator_feedback') {
      return { upsert: feedbackUpsert };
    }

    throw new Error(`Unexpected table ${table}`);
  });

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    eventInsert,
    feedbackUpsert,
    operations,
    rpc,
  };
}

describe('recordShowcaseFeedEvent idempotency', () => {
  it('rejects a mismatched replay before mutating feed preferences', async () => {
    const existing: ExistingEvent = {
      post_id: 'post-1',
      creator_user_id: 'creator-1',
      event_type: 'save',
      source_surface: 'showcase',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({ existingEvents: [existing] });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload(),
      serviceClient: service.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'Feed event ID is already used by a different event.' },
    });
    expect(service.eventInsert).not.toHaveBeenCalled();
    expect(service.feedbackUpsert).not.toHaveBeenCalled();
  });

  it('re-applies idempotent feedback for a matching replay without inserting another event', async () => {
    const existing: ExistingEvent = {
      post_id: 'post-1',
      creator_user_id: 'creator-1',
      event_type: 'not_interested',
      source_surface: 'showcase',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({ existingEvents: [existing] });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload(),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true, duplicate: true } });
    expect(service.eventInsert).not.toHaveBeenCalled();
    expect(service.feedbackUpsert).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact replay after its original delivery session has expired', async () => {
    const existing: ExistingEvent = {
      post_id: 'post-1',
      creator_user_id: 'creator-1',
      event_type: 'impression',
      source_surface: 'showcase',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({ existingEvents: [existing] });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({
        deliveryId: 'expired-delivery',
        eventType: 'impression',
        feedSessionId: 'expired-session',
      }),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true, duplicate: true } });
    expect(service.eventInsert).not.toHaveBeenCalled();
    expect(service.feedbackUpsert).not.toHaveBeenCalled();
  });

  it('rejects undelivered behavioral events for arbitrary public posts', async () => {
    const service = createServiceClient();

    const result = await recordShowcaseFeedEvent({
      actorUserId: null,
      anonymousKeyHash: 'anonymous-hash-value-with-at-least-32-characters',
      payload: payload({ eventType: 'impression' }),
      serviceClient: service.client,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(service.eventInsert).not.toHaveBeenCalled();
  });

  it.each(['follow', 'remix_complete', 'purchase', 'report'] as const)(
    'rejects the server-authoritative %s event from the public endpoint',
    async (eventType) => {
      const service = createServiceClient();
      const result = await recordShowcaseFeedEvent({
        actorUserId: 'viewer-1',
        anonymousKeyHash: 'anon-hash',
        payload: payload({ deliveryId: 'delivery-1', eventType }),
        serviceClient: service.client,
      });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(service.eventInsert).not.toHaveBeenCalled();
    },
  );

  it('requires anonymous feedback to reference a matching delivery', async () => {
    const service = createServiceClient();

    const result = await recordShowcaseFeedEvent({
      actorUserId: null,
      anonymousKeyHash: 'anonymous-hash-value-with-at-least-32-characters',
      payload: payload({ eventType: 'not_interested' }),
      serviceClient: service.client,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(service.eventInsert).not.toHaveBeenCalled();
    expect(service.feedbackUpsert).not.toHaveBeenCalled();
  });

  it('records save telemetry only when the signed authoritative state matches', async () => {
    const staleService = createServiceClient({ postSaved: false });
    const staleResult = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({ deliveryId: 'delivery-1', eventType: 'save' }),
      serviceClient: staleService.client,
    });
    expect(staleResult).toMatchObject({ ok: false, status: 409 });
    expect(staleService.eventInsert).not.toHaveBeenCalled();

    const savedService = createServiceClient({ postSaved: true });
    const savedResult = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({ eventType: 'save' }),
      serviceClient: savedService.client,
    });
    expect(savedResult).toEqual({ ok: true, body: { success: true } });
    expect(savedService.eventInsert).toHaveBeenCalledTimes(1);
  });

  it('handles a conflicting concurrent insert without applying mismatched feedback', async () => {
    const conflicting: ExistingEvent = {
      post_id: 'post-1',
      creator_user_id: 'creator-1',
      // This also matches the semantic per-viewer cap. The occupied client ID
      // must still win because its source differs from this request.
      event_type: 'not_interested',
      source_surface: 'showcase-reel',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({
      existingEvents: [null, conflicting],
      eventInsertError: { code: '23505' },
    });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload(),
      serviceClient: service.client,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(service.eventInsert).toHaveBeenCalledTimes(1);
    expect(service.feedbackUpsert).not.toHaveBeenCalled();
  });

  it('treats the per-viewer signal cap as an idempotent duplicate', async () => {
    const matching: ExistingEvent = {
      post_id: 'post-1',
      creator_user_id: 'creator-1',
      event_type: 'not_interested',
      source_surface: 'showcase-reel',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({
      existingEvents: [null, null, matching],
      eventInsertError: { code: '23505' },
    });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload(),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true, duplicate: true } });
    expect(service.eventInsert).toHaveBeenCalledTimes(1);
    expect(service.feedbackUpsert).toHaveBeenCalledTimes(1);
  });

  it('treats hiding an already-hidden creator from another post as a semantic duplicate', async () => {
    const matchingCreatorHide: ExistingEvent = {
      post_id: 'another-post-from-creator-1',
      creator_user_id: 'creator-1',
      event_type: 'hide_creator',
      source_surface: 'showcase-reel',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
    };
    const service = createServiceClient({
      existingEvents: [null, null, matchingCreatorHide],
      eventInsertError: { code: '23505' },
    });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({ eventType: 'hide_creator' }),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true, duplicate: true } });
    expect(service.feedbackUpsert).toHaveBeenCalledTimes(1);
  });

  it('records a new event before applying its preference side effect', async () => {
    const service = createServiceClient();

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload(),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(service.operations).toEqual(['event-insert', 'feedback-upsert']);
  });
});

describe('recordShowcaseFeedEvent media progress', () => {
  it('routes media_progress through the GREATEST-upsert RPC instead of a plain insert', async () => {
    const service = createServiceClient();

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({
        eventType: 'media_progress',
        deliveryId: 'delivery-1',
        feedSessionId: 'session-1',
        progress: 0.62,
        durationMs: 14_000,
      }),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(service.eventInsert).not.toHaveBeenCalled();
    expect(service.rpc).toHaveBeenCalledWith('record_feed_media_progress_event', {
      p_client_event_id: 'event-1',
      p_session_id: 'session-1',
      p_session_item_id: 'delivery-1',
      p_viewer_user_id: 'viewer-1',
      p_anonymous_key_hash: null,
      p_post_id: 'post-1',
      p_creator_user_id: 'creator-1',
      p_source_surface: 'showcase',
      p_position: 0,
      p_duration_ms: 14_000,
      p_progress: 0.62,
      p_metadata: {},
      p_occurred_at: '2026-07-11T08:00:00.000Z',
    });
  });

  it('rejects media_progress without a progress value before writing anything', async () => {
    const service = createServiceClient();

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({
        eventType: 'media_progress',
        deliveryId: 'delivery-1',
        feedSessionId: 'session-1',
        progress: null,
      }),
      serviceClient: service.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Media progress events require a progress value.' },
    });
    expect(service.rpc).not.toHaveBeenCalled();
    expect(service.eventInsert).not.toHaveBeenCalled();
  });

  it('treats a duplicate-keyed progress retry as an idempotent duplicate', async () => {
    const service = createServiceClient({
      rpcError: { code: '23505' },
      existingEvents: [null, {
        post_id: 'post-1',
        creator_user_id: 'creator-1',
        event_type: 'media_progress',
        source_surface: 'showcase',
        viewer_user_id: 'viewer-1',
        anonymous_key_hash: null,
      }],
    });

    const result = await recordShowcaseFeedEvent({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: payload({
        eventType: 'media_progress',
        deliveryId: 'delivery-1',
        feedSessionId: 'session-1',
        progress: 0.4,
      }),
      serviceClient: service.client,
    });

    expect(result).toEqual({ ok: true, body: { success: true, duplicate: true } });
  });
});

describe('recordShowcaseFeedEvents RPC wrapper', () => {
  it('sends one RPC for signed-in payloads and translates mixed outcomes', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        success: true,
        recorded: 1,
        rejected: 1,
        outcomes: [
          { index: 0, ok: true, duplicate: true },
          { index: 1, ok: false, status: 409, error: 'conflict' },
        ],
      },
      error: null,
    }));
    const payloads = [payload(), payload({ clientEventId: 'event-2' })];

    const result = await recordShowcaseFeedEvents({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payloads,
      serviceClient: { rpc } as unknown as SupabaseClient,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_showcase_feed_events', {
      p_actor_user_id: 'viewer-1',
      p_anonymous_key_hash: 'anon-hash',
      p_events: payloads,
    });
    expect(result).toEqual({
      ok: true,
      body: { success: true, recorded: 1, rejected: 1 },
      results: [
        { ok: true, body: { success: true, duplicate: true } },
        { ok: false, status: 409, body: { error: 'conflict' } },
      ],
    });
  });

  it('passes the guest identity and fails closed on transport or malformed responses', async () => {
    const payloads = [payload()];
    const transportRpc = vi.fn(async () => ({ data: null, error: { code: 'PGRST500' } }));
    const transportResult = await recordShowcaseFeedEvents({
      actorUserId: null,
      anonymousKeyHash: 'anonymous-hash-value-with-at-least-32-characters',
      payloads,
      serviceClient: { rpc: transportRpc } as unknown as SupabaseClient,
    });
    expect(transportRpc).toHaveBeenCalledWith('record_showcase_feed_events', expect.objectContaining({
      p_actor_user_id: null,
      p_anonymous_key_hash: 'anonymous-hash-value-with-at-least-32-characters',
    }));
    expect(transportResult).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to record feed event batch.' },
    });

    const malformedResult = await recordShowcaseFeedEvents({
      actorUserId: null,
      anonymousKeyHash: 'anonymous-hash-value-with-at-least-32-characters',
      payloads,
      serviceClient: {
        rpc: vi.fn(async () => ({
          data: { success: true, recorded: 1, rejected: 0, outcomes: [] },
          error: null,
        })),
      } as unknown as SupabaseClient,
    });
    expect(malformedResult.ok).toBe(false);
  });

  it('makes a per-entry server failure retryable for the whole batch', async () => {
    const payloads = [payload(), payload({ clientEventId: 'event-2' })];
    const result = await recordShowcaseFeedEvents({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payloads,
      serviceClient: {
        rpc: vi.fn(async () => ({
          data: {
            success: true,
            recorded: 1,
            rejected: 1,
            outcomes: [
              { index: 0, ok: true },
              { index: 1, ok: false, status: 500, error: 'temporary database failure' },
            ],
          },
          error: null,
        })),
      } as unknown as SupabaseClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to record feed event batch.' },
    });
  });
});
