import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
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
const SOURCE_SURFACES = new Set(['showcase', 'showcase-reel', 'feed']);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// The server's own event ids (`authoritativeClientEventId`), any case. A
// client that took one first would make the server's write read as a
// duplicate, suppressing another viewer's signal.
const SERVER_EVENT_ID_PATTERN = /^srv:/i;
const UUID_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_IDENTIFIER_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');
const MAX_METADATA_BYTES = 4_096;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_FUTURE_MS = 5 * 60 * 1_000;
// A client may never send these: the action that produces each is the only
// writer (`recordAuthoritativeFeedEvent` below). `comment` is not even a
// client type, so the parser already refuses it.
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
  sourceSurface: 'showcase' | 'showcase-reel' | 'feed';
  occurredAt: string;
  metadata: Record<string, string | number | boolean | null>;
};

export type ShowcaseFeedEventRecordResult =
  | { ok: true; body: { success: true; duplicate?: boolean } }
  | { ok: false; status: number; body: { error: string } };

export type ShowcaseFeedEventBatchRecordResult =
  | {
    ok: true;
    body: { success: true; recorded: number; rejected: number };
    results: ShowcaseFeedEventRecordResult[];
  }
  | { ok: false; status: 500; body: { error: string } };

export type ShowcaseFeedEventParseResult =
  | { ok: true; payload: ShowcaseFeedEventPayload }
  | { ok: false; status: 400; body: { error: string } };

/**
 * A fully-watched reel produces around seven events. Sent one per request that
 * is seven auth round-trips and seven rate-limit write transactions for one
 * viewer watching one clip.
 */
export const SHOWCASE_FEED_EVENT_BATCH_LIMIT = 25;

export type ShowcaseFeedEventBatchParseResult =
  | { ok: true; batched: boolean; payloads: ShowcaseFeedEventPayload[] }
  | { ok: false; status: 400; body: { error: string } };

/**
 * Accepts either `{ events: [...] }` or a bare single event.
 *
 * The single form is not legacy support to be removed later: mobile clients
 * ship on their own multi-week store train, so a build sending one event per
 * request stays in the wild indefinitely after the server learns to batch.
 * `batched` is returned so the caller can keep answering old clients in exactly
 * the shape they expect.
 */
export function parseShowcaseFeedEventBatchPayload(value: unknown): ShowcaseFeedEventBatchParseResult {
  const events = isRecord(value) && Array.isArray(value.events) ? value.events : null;

  if (events === null) {
    const single = parseShowcaseFeedEventPayload(value);
    return single.ok
      ? { ok: true, batched: false, payloads: [single.payload] }
      : single;
  }

  if (events.length === 0) {
    return { ok: false, status: 400, body: { error: 'Feed event batch is empty.' } };
  }
  if (events.length > SHOWCASE_FEED_EVENT_BATCH_LIMIT) {
    return {
      ok: false,
      status: 400,
      body: { error: `Feed event batch exceeds ${SHOWCASE_FEED_EVENT_BATCH_LIMIT} events.` },
    };
  }

  const payloads: ShowcaseFeedEventPayload[] = [];
  for (const event of events) {
    const parsed = parseShowcaseFeedEventPayload(event);
    // One malformed event must not discard the rest of a watch session. The
    // batch is telemetry, and a client cannot retry what it has already
    // dropped from its queue.
    if (parsed.ok) payloads.push(parsed.payload);
  }

  if (payloads.length === 0) {
    return { ok: false, status: 400, body: { error: 'Feed event batch contained no valid events.' } };
  }

  return { ok: true, batched: true, payloads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeOptionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && SAFE_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function normalizeOptionalUuidIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && UUID_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function normalizeOptionalBigintIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !BIGINT_IDENTIFIER_PATTERN.test(value)) return undefined;
  return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
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
  const feedSessionId = normalizeOptionalUuidIdentifier(value.feedSessionId);
  const deliveryId = normalizeOptionalBigintIdentifier(value.deliveryId);
  const postId = normalizeOptionalUuidIdentifier(value.postId);
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
  if (SERVER_EVENT_ID_PATTERN.test(clientEventId)) {
    return { ok: false, status: 400, body: { error: 'Feed event ID uses a prefix reserved for the server.' } };
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
      .select('id, session_id, post_id, position')
      .eq('id', payload.deliveryId)
      .maybeSingle();
    if (error || !data || data.post_id !== payload.postId || (payload.feedSessionId && data.session_id !== payload.feedSessionId)) {
      return { ok: false as const, error: 'Feed delivery does not match this post.' };
    }
    if (payload.position !== null && Number(data.position) !== payload.position) {
      return { ok: false as const, error: 'Feed event position does not match its delivery.' };
    }
    resolvedSessionId = String(data.session_id);
  }

  if (resolvedSessionId) {
    const { data, error } = await serviceClient
      .from('feed_sessions')
      .select('id, viewer_user_id, anonymous_key_hash, created_at, expires_at')
      .eq('id', resolvedSessionId)
      .maybeSingle();
    const occurredAtMs = Date.parse(payload.occurredAt);
    const sessionCreatedAtMs = data ? Date.parse(data.created_at) : Number.NaN;
    const sessionExpiresAtMs = data ? Date.parse(data.expires_at) : Number.NaN;
    if (
      error
      || !data
      || !Number.isFinite(occurredAtMs)
      || !Number.isFinite(sessionCreatedAtMs)
      || !Number.isFinite(sessionExpiresAtMs)
      || occurredAtMs < sessionCreatedAtMs
      || occurredAtMs >= sessionExpiresAtMs
    ) {
      return { ok: false as const, error: 'Feed session was not found or was inactive when this event occurred.' };
    }
    if (data.viewer_user_id !== null && data.viewer_user_id !== actorUserId) {
      return { ok: false as const, error: 'Feed session does not belong to this viewer.' };
    }
    if (
      data.viewer_user_id === null
      && (actorUserId !== null || data.anonymous_key_hash !== anonymousKeyHash)
    ) {
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
}): Promise<ShowcaseFeedEventRecordResult> {
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

    if (payload.eventType === 'media_progress' && payload.progress === null) {
      return { ok: false, status: 400, body: { error: 'Media progress events require a progress value.' } };
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

    // media_progress arrives repeatedly (milestone/background/exit flushes);
    // the RPC upserts the single per-delivery row with GREATEST semantics.
    const { error } = payload.eventType === 'media_progress'
      ? await serviceClient.rpc('record_feed_media_progress_event', {
        p_client_event_id: payload.clientEventId,
        p_session_id: payload.feedSessionId,
        p_session_item_id: payload.deliveryId,
        p_viewer_user_id: actorUserId,
        p_anonymous_key_hash: actorUserId ? null : anonymousKeyHash,
        p_post_id: payload.postId,
        p_creator_user_id: typedPost.user_id,
        p_source_surface: payload.sourceSurface,
        p_position: payload.position,
        p_duration_ms: payload.durationMs,
        p_progress: payload.progress,
        p_metadata: payload.metadata,
        p_occurred_at: payload.occurredAt,
      })
      : await serviceClient.from('feed_events').insert({
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
      if (existingResult.error) {
        return { ok: false, status: 500, body: { error: 'Failed to record feed event.' } };
      }
      const existingByClientIdMatches = Boolean(
        existingResult.data
        && existingEventMatchesRequest({
          actorUserId,
          anonymousKeyHash,
          creatorId: typedPost.user_id,
          existing: existingResult.data,
          payload,
        }),
      );
      if (existingResult.data && !existingByClientIdMatches) {
        return { ok: false, status: 409, body: { error: 'Feed event ID is already used by a different event.' } };
      }
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

type FeedEventBatchRpcOutcome = {
  index?: unknown;
  ok?: unknown;
  duplicate?: unknown;
  status?: unknown;
  error?: unknown;
};

type FeedEventBatchRpcResponse = {
  success?: unknown;
  recorded?: unknown;
  rejected?: unknown;
  outcomes?: unknown;
};

/**
 * Sends a parsed batch through one service-role RPC. Deep event semantics live
 * in the database so the inserts and preference side effects share one
 * transaction; this wrapper only validates and translates the RPC contract.
 */
export async function recordShowcaseFeedEvents({
  actorUserId,
  anonymousKeyHash,
  payloads,
  serviceClient,
}: {
  actorUserId: string | null;
  anonymousKeyHash: string;
  payloads: ShowcaseFeedEventPayload[];
  serviceClient: SupabaseClient;
}): Promise<ShowcaseFeedEventBatchRecordResult> {
  const { data, error } = await serviceClient.rpc('record_showcase_feed_events', {
    p_actor_user_id: actorUserId,
    p_anonymous_key_hash: anonymousKeyHash,
    p_events: payloads,
  });

  if (error || !isRecord(data)) {
    return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
  }

  const response = data as FeedEventBatchRpcResponse;
  const outcomes = Array.isArray(response.outcomes)
    ? response.outcomes as FeedEventBatchRpcOutcome[]
    : null;
  if (
    response.success !== true
    || !Number.isInteger(response.recorded)
    || !Number.isInteger(response.rejected)
    || !outcomes
    || outcomes.length !== payloads.length
  ) {
    return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
  }

  const results: ShowcaseFeedEventRecordResult[] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (!isRecord(outcome) || outcome.index !== index || typeof outcome.ok !== 'boolean') {
      return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
    }
    if (outcome.ok) {
      results.push(outcome.duplicate === true
        ? { ok: true, body: { success: true, duplicate: true } }
        : { ok: true, body: { success: true } });
      continue;
    }
    if (!Number.isInteger(outcome.status) || typeof outcome.error !== 'string') {
      return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
    }
    results.push({
      ok: false,
      status: outcome.status as number,
      body: { error: outcome.error },
    });
  }

  const recorded = response.recorded as number;
  const rejected = response.rejected as number;
  if (
    recorded !== results.filter((result) => result.ok).length
    || rejected !== results.filter((result) => !result.ok).length
  ) {
    return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
  }

  // Defensive compatibility for a database function that reports an
  // unexpected per-entry failure rather than throwing. Mobile acknowledges a
  // successful HTTP response as durable, so any retryable outcome must make
  // the whole transport retryable.
  if (results.some((result) => !result.ok && result.status >= 500)) {
    return { ok: false, status: 500, body: { error: 'Failed to record feed event batch.' } };
  }

  return {
    ok: true,
    body: { success: true, recorded, rejected },
    results,
  };
}

// ---------------------------------------------------------------------------
// Server-written events
// ---------------------------------------------------------------------------

/**
 * The feed events no client may send, each written by the server action that
 * makes it true: a comment created, a follow recorded, a remix finished, a
 * purchase settled, a post reported.
 */
export const AUTHORITATIVE_FEED_EVENT_TYPES = ['comment', 'follow', 'remix_complete', 'purchase', 'report'] as const;

export type AuthoritativeFeedEventType = typeof AUTHORITATIVE_FEED_EVENT_TYPES[number];

/**
 * The longest a server-written event may hold the action it rides on. It is
 * telemetry: past this the action answers without it.
 */
export const AUTHORITATIVE_FEED_EVENT_TIMEOUT_MS = 1_500;

/** `feed_events.source_surface` for every server-written event. */
export const AUTHORITATIVE_FEED_EVENT_SOURCE_SURFACE = 'server';

/**
 * Reads the optional `deliveryId` a client sends with an action taken from a
 * feed card (`recommendation.deliveryId`, a bigint as a string). Anything
 * malformed is null: a telemetry field never fails the action it rides on.
 */
export function parseFeedDeliveryIdField(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return normalizeOptionalBigintIdentifier(typeof value === 'string' ? value.trim() : null) ?? null;
}

export type AuthoritativeFeedEventInput = {
  eventType: AuthoritativeFeedEventType;
  /** Who acted: the commenter, the follower, the remixer, the buyer, the reporter. */
  viewerUserId: string;
  /**
   * The post the action was taken on (for a remix, the original). May be left
   * out when a `deliveryId` is given: the delivery's post is then the post.
   */
  postId?: string | null;
  /**
   * When set, the post must be this creator's or nothing is written: a follow
   * is attributed only to a post of the creator who was followed.
   */
  expectedCreatorUserId?: string | null;
  /**
   * The delivery the client acted from (`recommendation.deliveryId`), when it
   * sent one. Kept only when it is a delivery of this post to this viewer;
   * anything else is dropped and the event is written without one.
   */
  deliveryId?: string | null;
  occurredAt?: string | Date | null;
  /**
   * What makes this one action, so a retried action is written once. Default:
   * the viewer, the post and the delivery — one comment or follow event per
   * delivery, however many times the viewer acts from it.
   */
  actionKey?: string | null;
  /**
   * With no `deliveryId`: attribute the action to the delivery of the viewer's
   * latest event of these types on the post within the window — the
   * `remix_start` a finished remix began from, say.
   */
  inferDeliveryFrom?: { eventTypes: ShowcaseFeedEventType[]; withinHours: number } | null;
  timeoutMs?: number;
};

export type AuthoritativeFeedEventResult =
  | { status: 'recorded' | 'duplicate'; deliveryId: string | null }
  | { status: 'skipped'; reason: 'invalid_input' | 'post_unavailable' | 'self_engagement' | 'creator_mismatch' }
  | { status: 'failed'; reason: 'timeout' | 'error' };

type AuthoritativeDelivery = {
  deliveryId: string;
  sessionId: string;
  position: number | null;
};

const AUTHORITATIVE_FEED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUTHORITATIVE_FEED_EVENT_TYPES);
const CLIENT_EVENT_ID_MAX_LENGTH = 128;

function authoritativeOccurredAt(value: AuthoritativeFeedEventInput['occurredAt'], nowMs: number) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  // Never in the future: `feed_events_clock_skew_check` bounds it by receipt.
  return new Date(Number.isFinite(parsed) ? Math.min(parsed, nowMs) : nowMs).toISOString();
}

function authoritativeClientEventId(eventType: AuthoritativeFeedEventType, key: string) {
  const id = `srv:${eventType}:${key}`;
  return id.length <= CLIENT_EVENT_ID_MAX_LENGTH
    ? id
    : `srv:${eventType}:${createHash('sha256').update(key).digest('hex')}`;
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
}

/**
 * After a unique-key conflict: the row holding this action's client event id,
 * when it is this action written before (the same type, viewer and post) —
 * a duplicate. Null when no row holds the id (the conflict was another key).
 * A row of any other event under the id is not this action: reporting a
 * duplicate would drop the signal without a trace, so it throws.
 */
async function existingAuthoritativeFeedEvent(
  serviceClient: SupabaseClient,
  { clientEventId, eventType, postId, viewerUserId }: {
    clientEventId: string;
    eventType: AuthoritativeFeedEventType;
    postId: string;
    viewerUserId: string;
  },
): Promise<AuthoritativeFeedEventResult | null> {
  const { data, error } = await serviceClient
    .from('feed_events')
    .select('event_type, viewer_user_id, post_id, session_item_id')
    .eq('client_event_id', clientEventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (
    data.event_type !== eventType
    || String(data.viewer_user_id ?? '').toLowerCase() !== viewerUserId
    || String(data.post_id ?? '').toLowerCase() !== postId
  ) {
    throw new Error('Feed event ID is already used by a different event');
  }
  return { status: 'duplicate', deliveryId: data.session_item_id ? String(data.session_item_id) : null };
}

/**
 * The delivery when it is one of this post, served to this viewer in a session
 * that began before the action; otherwise null. A pruned session or item reads
 * as no delivery.
 */
async function resolveAuthoritativeDelivery(
  serviceClient: SupabaseClient,
  { deliveryId, occurredAt, postId, viewerUserId }: {
    deliveryId: string;
    occurredAt: string;
    postId: string;
    viewerUserId: string;
  },
): Promise<AuthoritativeDelivery | null> {
  const { data: item, error: itemError } = await serviceClient
    .from('feed_session_items')
    .select('id, session_id, post_id, position')
    .eq('id', deliveryId)
    .maybeSingle();
  if (itemError || !item || String(item.post_id).toLowerCase() !== postId || !item.session_id) return null;

  const { data: session, error: sessionError } = await serviceClient
    .from('feed_sessions')
    .select('id, viewer_user_id, created_at')
    .eq('id', item.session_id)
    .maybeSingle();
  if (sessionError || !session || String(session.viewer_user_id).toLowerCase() !== viewerUserId) return null;
  const createdAtMs = Date.parse(String(session.created_at));
  if (!Number.isFinite(createdAtMs) || createdAtMs > Date.parse(occurredAt)) return null;

  const position = Number(item.position);
  return {
    deliveryId,
    sessionId: String(item.session_id),
    position: Number.isInteger(position) && position >= 0 ? position : null,
  };
}

/** The delivery of the viewer's latest event of these types on the post, in the window. */
async function inferAuthoritativeDeliveryId(
  serviceClient: SupabaseClient,
  { eventTypes, occurredAt, postId, viewerUserId, withinHours }: {
    eventTypes: ShowcaseFeedEventType[];
    occurredAt: string;
    postId: string;
    viewerUserId: string;
    withinHours: number;
  },
) {
  if (eventTypes.length === 0 || !(withinHours > 0)) return null;
  const since = new Date(Date.parse(occurredAt) - withinHours * 3_600_000).toISOString();
  const { data, error } = await serviceClient
    .from('feed_events')
    .select('session_item_id')
    .eq('viewer_user_id', viewerUserId)
    .eq('post_id', postId)
    .in('event_type', eventTypes)
    .not('session_item_id', 'is', null)
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeOptionalBigintIdentifier(String(data.session_item_id)) ?? null;
}

async function writeAuthoritativeFeedEvent(
  serviceClient: SupabaseClient,
  input: AuthoritativeFeedEventInput,
): Promise<AuthoritativeFeedEventResult> {
  const nowMs = Date.now();
  if (
    !AUTHORITATIVE_FEED_EVENT_TYPE_SET.has(input.eventType)
    || typeof input.viewerUserId !== 'string'
    || !UUID_IDENTIFIER_PATTERN.test(input.viewerUserId)
  ) {
    return { status: 'skipped', reason: 'invalid_input' };
  }
  const occurredAt = authoritativeOccurredAt(input.occurredAt, nowMs);
  // A malformed client id is no delivery; the action itself still counts.
  const requestedDeliveryId = parseFeedDeliveryIdField(input.deliveryId);

  // Ids are compared as text below, and the database returns them lowercase.
  const viewerUserId = input.viewerUserId.toLowerCase();
  let postId = typeof input.postId === 'string' && UUID_IDENTIFIER_PATTERN.test(input.postId)
    ? input.postId.toLowerCase()
    : null;
  if (!postId && requestedDeliveryId) {
    const { data: item, error: itemError } = await serviceClient
      .from('feed_session_items')
      .select('post_id')
      .eq('id', requestedDeliveryId)
      .maybeSingle();
    if (itemError) throw itemError;
    postId = typeof item?.post_id === 'string' && UUID_IDENTIFIER_PATTERN.test(item.post_id)
      ? item.post_id.toLowerCase()
      : null;
  }
  if (!postId) return { status: 'skipped', reason: 'invalid_input' };

  const { data: post, error: postError } = await serviceClient
    .from('posts')
    .select('id, user_id, visibility, archived_at')
    .eq('id', postId)
    .maybeSingle();
  if (postError) throw postError;
  const typedPost = post as FeedPostRow | null;
  if (!typedPost || typedPost.visibility !== 'public' || typedPost.archived_at) {
    return { status: 'skipped', reason: 'post_unavailable' };
  }
  const creatorUserId = String(typedPost.user_id).toLowerCase();
  // A creator replying under their own post, or remixing it, says nothing
  // about what the feed should show anyone.
  if (creatorUserId === viewerUserId) {
    return { status: 'skipped', reason: 'self_engagement' };
  }
  if (input.expectedCreatorUserId && creatorUserId !== input.expectedCreatorUserId.toLowerCase()) {
    return { status: 'skipped', reason: 'creator_mismatch' };
  }

  const candidateDeliveryId = requestedDeliveryId ?? (input.inferDeliveryFrom
    ? await inferAuthoritativeDeliveryId(serviceClient, {
      ...input.inferDeliveryFrom,
      occurredAt,
      postId,
      viewerUserId,
    })
    : null);
  const delivery = candidateDeliveryId
    ? await resolveAuthoritativeDelivery(serviceClient, {
      deliveryId: candidateDeliveryId,
      occurredAt,
      postId,
      viewerUserId,
    })
    : null;

  const actionKey = typeof input.actionKey === 'string' && input.actionKey.trim()
    ? input.actionKey.trim()
    : `${viewerUserId}:${postId}:${delivery?.deliveryId ?? '-'}`;
  const clientEventId = authoritativeClientEventId(input.eventType, actionKey);
  const insert = (attached: AuthoritativeDelivery | null) => serviceClient.from('feed_events').insert({
    client_event_id: clientEventId,
    session_id: attached?.sessionId ?? null,
    session_item_id: attached?.deliveryId ?? null,
    viewer_user_id: viewerUserId,
    anonymous_key_hash: null,
    post_id: postId,
    creator_user_id: typedPost.user_id,
    event_type: input.eventType,
    source_surface: AUTHORITATIVE_FEED_EVENT_SOURCE_SURFACE,
    position: attached?.position ?? null,
    duration_ms: null,
    progress: null,
    metadata: {},
    occurred_at: occurredAt,
  });

  const action = { clientEventId, eventType: input.eventType, postId, viewerUserId };
  const { error } = await insert(delivery);
  if (!error) return { status: 'recorded', deliveryId: delivery?.deliveryId ?? null };
  if (!delivery) {
    // Without a delivery only the client event id can conflict.
    const existing = errorCode(error) === '23505' ? await existingAuthoritativeFeedEvent(serviceClient, action) : null;
    if (existing) return existing;
    throw error;
  }

  // With a delivery a conflict is either this action written before (the
  // client event id) or another action of the type already attributed to the
  // delivery (one per delivery). Only the first is a duplicate; the second,
  // like a delivery pruned since it was checked, is written without one.
  if (errorCode(error) === '23505') {
    const existing = await existingAuthoritativeFeedEvent(serviceClient, action);
    if (existing) return existing;
  }
  const { error: retryError } = await insert(null);
  if (!retryError) return { status: 'recorded', deliveryId: null };
  const existing = errorCode(retryError) === '23505'
    ? await existingAuthoritativeFeedEvent(serviceClient, action)
    : null;
  if (existing) return existing;
  throw retryError;
}

/**
 * Writes one server-authoritative feed event (`comment`, `follow`,
 * `remix_complete`, `purchase`, `report`) on behalf of the action that makes
 * it true.
 *
 * It bypasses the client allowlist, which refuses all five, and writes the row
 * the way `recordShowcaseFeedEvent` does: a direct service-role insert, so the
 * database's own triggers validate the delivery context and stamp the outcome
 * on its delivery fact (a report's `reported_at`). This insert is the only way
 * a `report` reaches the table: the batch RPC refuses it from every caller.
 *
 * Telemetry riding on a real action, so it can never fail or hold that action:
 * it never throws, gives up after `timeoutMs`, and is written at most once per
 * action — the client event id is derived from `actionKey`, so a retried
 * action is a duplicate, not a second event.
 */
export async function recordAuthoritativeFeedEvent(
  serviceClient: SupabaseClient,
  input: AuthoritativeFeedEventInput,
): Promise<AuthoritativeFeedEventResult> {
  const timeoutMs = input.timeoutMs ?? AUTHORITATIVE_FEED_EVENT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AuthoritativeFeedEventResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), timeoutMs);
  });
  const write = writeAuthoritativeFeedEvent(serviceClient, input).catch((error: unknown) => {
    logBackendWarning('authoritative_feed_event_failed', {
      eventType: input.eventType,
      postId: input.postId,
      error,
    });
    return { status: 'failed', reason: 'error' } as const;
  });

  try {
    const result = await Promise.race([write, timeout]);
    if (result.status === 'failed' && result.reason === 'timeout') {
      logBackendWarning('authoritative_feed_event_timed_out', {
        eventType: input.eventType,
        postId: input.postId,
        timeoutMs,
      });
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs `recordAuthoritativeFeedEvent` once the caller has answered its request
 * when the route hands over a scheduler (`after()`), so the action's answer
 * never waits on it; without one, or when the scheduler refuses the task, it
 * runs before this returns, bounded by its timeout.
 */
export async function scheduleAuthoritativeFeedEvent(
  runAfterResponse: ((task: () => Promise<unknown>) => void) | undefined,
  serviceClient: SupabaseClient,
  input: AuthoritativeFeedEventInput,
): Promise<void> {
  const task = () => recordAuthoritativeFeedEvent(serviceClient, input);
  if (runAfterResponse) {
    try {
      runAfterResponse(task);
      return;
    } catch (error) {
      logBackendWarning('authoritative_feed_event_deferral_failed', { eventType: input.eventType, error });
    }
  }
  await task();
}
