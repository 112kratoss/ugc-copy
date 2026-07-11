import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export { getFeedAnonymousKeyHash } from '@/lib/showcase-feed-identity';
import type { ShowcaseFeedEventType } from '@/lib/showcase';

const EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
  'save',
  'unsave',
  'share',
  'follow',
  'remix_start',
  'remix_complete',
  'resource_open',
  'purchase',
  'not_interested',
  'hide_creator',
  'report',
]);
const SOURCE_SURFACES = new Set(['showcase', 'showcase-reel']);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_METADATA_BYTES = 4_096;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1_000;
const SERVER_AUTHORITATIVE_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'follow',
  'remix_complete',
  'purchase',
  'report',
]);
const FEEDBACK_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'not_interested',
  'hide_creator',
]);
const SAVE_STATE_EVENT_TYPES = new Set<ShowcaseFeedEventType>(['save', 'unsave']);
const DELIVERY_REQUIRED_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
  'share',
  'remix_start',
  'resource_open',
]);

export type ShowcaseFeedEventPayload = {
  clientEventId: string;
  feedSessionId: string | null;
  deliveryId: string | null;
  postId: string;
  eventType: ShowcaseFeedEventType;
  position: number | null;
  durationMs: number | null;
  progress: number | null;
  sourceSurface: 'showcase' | 'showcase-reel';
  occurredAt: string;
  metadata: Record<string, string | number | boolean | null>;
};

export type ShowcaseFeedEventParseResult =
  | { ok: true; payload: ShowcaseFeedEventPayload }
  | { ok: false; status: 400; body: { error: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeOptionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function normalizeOptionalInteger(value: unknown, max: number) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max ? number : undefined;
}

function normalizeOptionalProgress(value: unknown) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const normalized = number > 1 && number <= 100 ? number / 100 : number;
  return normalized >= 0 && normalized <= 1 ? normalized : undefined;
}

function normalizeMetadata(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;

  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_]{1,48}$/.test(key)) continue;
    if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') {
      normalized[key] = typeof raw === 'string' ? raw.slice(0, 256) : raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      normalized[key] = raw;
    }
  }

  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= MAX_METADATA_BYTES
    ? normalized
    : undefined;
}

export function parseShowcaseFeedEventPayload(value: unknown): ShowcaseFeedEventParseResult {
  if (!isRecord(value)) {
    return { ok: false, status: 400, body: { error: 'Invalid feed event payload.' } };
  }

  const clientEventId = normalizeOptionalIdentifier(value.clientEventId);
  const feedSessionId = normalizeOptionalIdentifier(value.feedSessionId);
  const deliveryId = normalizeOptionalIdentifier(value.deliveryId);
  const postId = normalizeOptionalIdentifier(value.postId);
  const position = normalizeOptionalInteger(value.position, 10_000);
  const durationMs = normalizeOptionalInteger(value.durationMs, 24 * 60 * 60 * 1_000);
  const progress = normalizeOptionalProgress(value.progress);
  const metadata = normalizeMetadata(value.metadata);
  const eventType = typeof value.eventType === 'string' && EVENT_TYPES.has(value.eventType as ShowcaseFeedEventType)
    ? value.eventType as ShowcaseFeedEventType
    : null;
  const sourceSurface = typeof value.sourceSurface === 'string' && SOURCE_SURFACES.has(value.sourceSurface)
    ? value.sourceSurface as ShowcaseFeedEventPayload['sourceSurface']
    : null;

  if (!clientEventId || !postId || !eventType || !sourceSurface) {
    return { ok: false, status: 400, body: { error: 'Feed event is missing a valid ID, post, type, or surface.' } };
  }
  if (feedSessionId === undefined || deliveryId === undefined || position === undefined || durationMs === undefined || progress === undefined) {
    return { ok: false, status: 400, body: { error: 'Feed event contains an invalid optional field.' } };
  }
  if (metadata === undefined) {
    return { ok: false, status: 400, body: { error: 'Feed event metadata is invalid or too large.' } };
  }

  const occurredAtDate = typeof value.occurredAt === 'string' ? new Date(value.occurredAt) : new Date();
  const occurredAtMs = occurredAtDate.getTime();
  const now = Date.now();
  if (
    !Number.isFinite(occurredAtMs)
    || occurredAtMs < now - MAX_EVENT_AGE_MS
    || occurredAtMs > now + MAX_EVENT_FUTURE_MS
  ) {
    return { ok: false, status: 400, body: { error: 'Feed event timestamp is outside the accepted window.' } };
  }

  return {
    ok: true,
    payload: {
      clientEventId,
      feedSessionId,
      deliveryId,
      postId,
      eventType,
      position,
      durationMs,
      progress,
      sourceSurface,
      occurredAt: occurredAtDate.toISOString(),
      metadata,
    },
  };
}

type FeedPostRow = {
  id: string;
  user_id: string;
  visibility: string;
  archived_at: string | null;
};

type ExistingFeedEventRow = {
  post_id: string;
  creator_user_id: string;
  event_type: ShowcaseFeedEventType;
  source_surface: string;
  viewer_user_id: string | null;
  anonymous_key_hash: string | null;
};

async function validateDelivery({
  actorUserId,
  anonymousKeyHash,
  payload,
  serviceClient,
}: {
  actorUserId: string | null;
  anonymousKeyHash: string;
  payload: ShowcaseFeedEventPayload;
  serviceClient: SupabaseClient;
}) {
  if (!payload.deliveryId && !payload.feedSessionId) return { ok: true as const };

  let resolvedSessionId = payload.feedSessionId;

  if (payload.deliveryId) {
    const { data, error } = await serviceClient
      .from('feed_session_items')
      .select('id, session_id, post_id')
      .eq('id', payload.deliveryId)
      .maybeSingle();
    if (error || !data || data.post_id !== payload.postId || (payload.feedSessionId && data.session_id !== payload.feedSessionId)) {
      return { ok: false as const, error: 'Feed delivery does not match this post.' };
    }
    resolvedSessionId = String(data.session_id);
  }

  if (resolvedSessionId) {
    const { data, error } = await serviceClient
      .from('feed_sessions')
      .select('id, viewer_user_id, anonymous_key_hash, expires_at')
      .eq('id', resolvedSessionId)
      .maybeSingle();
    if (error || !data || Date.parse(data.expires_at) <= Date.now()) {
      return { ok: false as const, error: 'Feed session was not found or has expired.' };
    }
    if (data.viewer_user_id && data.viewer_user_id !== actorUserId) {
      return { ok: false as const, error: 'Feed session does not belong to this viewer.' };
    }
    if (!data.viewer_user_id && data.anonymous_key_hash && data.anonymous_key_hash !== anonymousKeyHash) {
      return { ok: false as const, error: 'Feed session does not belong to this viewer.' };
    }
  }

  return { ok: true as const };
}

async function validateAuthoritativeSaveState({
  actorUserId,
  payload,
  serviceClient,
}: {
  actorUserId: string;
  payload: ShowcaseFeedEventPayload;
  serviceClient: SupabaseClient;
}) {
  const { data, error } = await serviceClient
    .from('post_saves')
    .select('post_id')
    .eq('user_id', actorUserId)
    .eq('post_id', payload.postId)
    .maybeSingle();
  if (error) {
    return { ok: false as const, status: 500, error: 'Failed to verify the authoritative save state.' };
  }

  const expectedSavedState = payload.eventType === 'save';
  if (Boolean(data) !== expectedSavedState) {
    return { ok: false as const, status: 409, error: 'Feed save event does not match the authoritative save state.' };
  }

  return { ok: true as const };
}

async function persistFeedback({
  actorUserId,
  creatorId,
  payload,
  serviceClient,
}: {
  actorUserId: string | null;
  creatorId: string;
  payload: ShowcaseFeedEventPayload;
  serviceClient: SupabaseClient;
}) {
  if (!actorUserId) return null;

  if (payload.eventType === 'not_interested') {
    const { error } = await serviceClient.from('feed_user_post_feedback').upsert({
      user_id: actorUserId,
      post_id: payload.postId,
      feedback_type: 'not_interested',
      updated_at: payload.occurredAt,
    }, { onConflict: 'user_id,post_id' });
    return error;
  }

  if (payload.eventType === 'hide_creator') {
    const { error } = await serviceClient.from('feed_user_creator_feedback').upsert({
      user_id: actorUserId,
      creator_user_id: creatorId,
      feedback_type: 'hide_creator',
      updated_at: payload.occurredAt,
    }, { onConflict: 'user_id,creator_user_id' });
    return error;
  }

  return null;
}

async function loadExistingFeedEvent(
  serviceClient: SupabaseClient,
  clientEventId: string,
) {
  const { data, error } = await serviceClient
    .from('feed_events')
    .select('post_id, creator_user_id, event_type, source_surface, viewer_user_id, anonymous_key_hash')
    .eq('client_event_id', clientEventId)
    .maybeSingle();
  return { data: data as ExistingFeedEventRow | null, error };
}

async function loadCappedFeedEvent({
  actorUserId,
  creatorId,
  payload,
  serviceClient,
}: {
  actorUserId: string | null;
  creatorId: string;
  payload: ShowcaseFeedEventPayload;
  serviceClient: SupabaseClient;
}) {
  const columns = 'post_id, creator_user_id, event_type, source_surface, viewer_user_id, anonymous_key_hash';

  if (payload.deliveryId) {
    const { data, error } = await serviceClient
      .from('feed_events')
      .select(columns)
      .eq('session_item_id', payload.deliveryId)
      .eq('event_type', payload.eventType)
      .maybeSingle();
    if (data || error) return { data: data as ExistingFeedEventRow | null, error };
  }

  if (actorUserId && (payload.eventType === 'save' || payload.eventType === 'unsave' || payload.eventType === 'not_interested')) {
    const { data, error } = await serviceClient
      .from('feed_events')
      .select(columns)
      .eq('viewer_user_id', actorUserId)
      .eq('post_id', payload.postId)
      .eq('event_type', payload.eventType)
      .maybeSingle();
    if (data || error) return { data: data as ExistingFeedEventRow | null, error };
  }

  if (actorUserId && payload.eventType === 'hide_creator') {
    const { data, error } = await serviceClient
      .from('feed_events')
      .select(columns)
      .eq('viewer_user_id', actorUserId)
      .eq('creator_user_id', creatorId)
      .eq('event_type', payload.eventType)
      .maybeSingle();
    return { data: data as ExistingFeedEventRow | null, error };
  }

  return { data: null, error: null };
}

function existingEventMatchesRequest({
  actorUserId,
  anonymousKeyHash,
  creatorId,
  existing,
  payload,
}: {
  actorUserId: string | null;
  anonymousKeyHash: string;
  creatorId: string;
  existing: ExistingFeedEventRow;
  payload: ShowcaseFeedEventPayload;
}) {
  return existing.post_id === payload.postId
    && existing.creator_user_id === creatorId
    && existing.event_type === payload.eventType
    && existing.source_surface === payload.sourceSurface
    && existing.viewer_user_id === actorUserId
    && existing.anonymous_key_hash === (actorUserId ? null : anonymousKeyHash);
}

function existingCappedEventMatchesRequest({
  actorUserId,
  anonymousKeyHash,
  creatorId,
  existing,
  payload,
}: {
  actorUserId: string | null;
  anonymousKeyHash: string;
  creatorId: string;
  existing: ExistingFeedEventRow;
  payload: ShowcaseFeedEventPayload;
}) {
  return (payload.eventType === 'hide_creator' || existing.post_id === payload.postId)
    && existing.creator_user_id === creatorId
    && existing.event_type === payload.eventType
    && existing.viewer_user_id === actorUserId
    && existing.anonymous_key_hash === (actorUserId ? null : anonymousKeyHash);
}

export async function recordShowcaseFeedEvent({
  actorUserId,
  anonymousKeyHash,
  payload,
  serviceClient,
}: {
  actorUserId: string | null;
  anonymousKeyHash: string;
  payload: ShowcaseFeedEventPayload;
  serviceClient: SupabaseClient;
}): Promise<
  | { ok: true; body: { success: true; duplicate?: boolean } }
  | { ok: false; status: number; body: { error: string } }
> {
  const { data: post, error: postError } = await serviceClient
    .from('posts')
    .select('id, user_id, visibility, archived_at')
    .eq('id', payload.postId)
    .maybeSingle();
  const typedPost = post as FeedPostRow | null;
  if (postError || !typedPost || typedPost.visibility !== 'public' || typedPost.archived_at) {
    return { ok: false, status: 404, body: { error: 'Public feed post was not found.' } };
  }

  if (payload.eventType === 'hide_creator' && actorUserId === typedPost.user_id) {
    return { ok: false, status: 400, body: { error: 'Creators cannot hide their own profile.' } };
  }

  if (SERVER_AUTHORITATIVE_EVENT_TYPES.has(payload.eventType)) {
    return { ok: false, status: 400, body: { error: 'This feed event must be recorded by its authoritative server action.' } };
  }

  let duplicate = false;
  let existingResult = await loadExistingFeedEvent(serviceClient, payload.clientEventId);
  if (existingResult.error) {
    return { ok: false, status: 500, body: { error: 'Failed to check feed event idempotency.' } };
  }
  if (existingResult.data) {
    if (!existingEventMatchesRequest({
      actorUserId,
      anonymousKeyHash,
      creatorId: typedPost.user_id,
      existing: existingResult.data,
      payload,
    })) {
      return { ok: false, status: 409, body: { error: 'Feed event ID is already used by a different event.' } };
    }
    duplicate = true;
  }

  if (!duplicate) {
    if (SAVE_STATE_EVENT_TYPES.has(payload.eventType) && !actorUserId) {
      return { ok: false, status: 401, body: { error: 'Authentication is required for feed save events.' } };
    }

    const isFeedbackEvent = FEEDBACK_EVENT_TYPES.has(payload.eventType);
    if (
      !payload.deliveryId
      && (
        DELIVERY_REQUIRED_EVENT_TYPES.has(payload.eventType)
        || (isFeedbackEvent && !actorUserId)
      )
    ) {
      return { ok: false, status: 400, body: { error: 'A matching feed delivery is required for this event.' } };
    }

    const deliveryValidation = await validateDelivery({ actorUserId, anonymousKeyHash, payload, serviceClient });
    if (!deliveryValidation.ok) {
      return { ok: false, status: 400, body: { error: deliveryValidation.error } };
    }

    if (SAVE_STATE_EVENT_TYPES.has(payload.eventType) && actorUserId) {
      const saveStateValidation = await validateAuthoritativeSaveState({
        actorUserId,
        payload,
        serviceClient,
      });
      if (!saveStateValidation.ok) {
        return {
          ok: false,
          status: saveStateValidation.status,
          body: { error: saveStateValidation.error },
        };
      }
    }

    const { error } = await serviceClient.from('feed_events').insert({
      client_event_id: payload.clientEventId,
      session_id: payload.feedSessionId,
      session_item_id: payload.deliveryId,
      viewer_user_id: actorUserId,
      anonymous_key_hash: actorUserId ? null : anonymousKeyHash,
      post_id: payload.postId,
      creator_user_id: typedPost.user_id,
      event_type: payload.eventType,
      source_surface: payload.sourceSurface,
      position: payload.position,
      duration_ms: payload.durationMs,
      progress: payload.progress,
      metadata: payload.metadata,
      occurred_at: payload.occurredAt,
    });

    if (error?.code === '23505') {
      existingResult = await loadExistingFeedEvent(serviceClient, payload.clientEventId);
      const existingByClientIdMatches = Boolean(
        !existingResult.error
        && existingResult.data
        && existingEventMatchesRequest({
          actorUserId,
          anonymousKeyHash,
          creatorId: typedPost.user_id,
          existing: existingResult.data,
          payload,
        }),
      );
      const cappedResult = existingByClientIdMatches
        ? { data: null, error: null }
        : await loadCappedFeedEvent({
          actorUserId,
          creatorId: typedPost.user_id,
          payload,
          serviceClient,
        });
      const existingCappedEventMatches = Boolean(
        !cappedResult.error
        && cappedResult.data
        && existingCappedEventMatchesRequest({
          actorUserId,
          anonymousKeyHash,
          creatorId: typedPost.user_id,
          existing: cappedResult.data,
          payload,
        }),
      );
      if (!existingByClientIdMatches && !existingCappedEventMatches) {
        return { ok: false, status: 409, body: { error: 'Feed event ID is already used by a different event.' } };
      }
      duplicate = true;
    } else if (error) {
      return { ok: false, status: 500, body: { error: 'Failed to record feed event.' } };
    }
  }

  const feedbackError = await persistFeedback({
    actorUserId,
    creatorId: typedPost.user_id,
    payload,
    serviceClient,
  });
  if (feedbackError) {
    return { ok: false, status: 500, body: { error: 'Failed to save feed preference.' } };
  }

  return duplicate
    ? { ok: true, body: { success: true, duplicate: true } }
    : { ok: true, body: { success: true } };
}
