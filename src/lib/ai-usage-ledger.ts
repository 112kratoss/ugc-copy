import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

export class AiUsageLedgerError extends Error {
  status: number;
  code:
    | 'INSUFFICIENT_CREDITS'
    | 'USAGE_EVENT_FAILED'
    | 'INVALID_AI_USAGE_REQUEST'
    | 'AI_USAGE_PROFILE_NOT_FOUND'
    | 'INVALID_IDEMPOTENCY_KEY'
    | 'IDEMPOTENCY_KEY_MISMATCH'
    | 'AI_USAGE_IN_PROGRESS'
    | 'AI_USAGE_REPLAY_UNAVAILABLE'
    | 'AI_USAGE_KEY_ALREADY_USED';
  requiredCredits?: number;

  constructor(
    message: string,
    status: number,
    code: AiUsageLedgerError['code'],
    requiredCredits?: number,
  ) {
    super(message);
    this.name = 'AiUsageLedgerError';
    this.status = status;
    this.code = code;
    this.requiredCredits = requiredCredits;
  }
}

export type AiUsageLedgerStartInput = {
  userId: string;
  cost: number;
  feature: string;
  provider: string;
  model: string;
  medium: string | null;
  inputPrompt: string;
  idempotencyKey?: string | null;
};

export type AiUsageLedger = {
  eventId: string;
  remainingCredits: number;
  cost: number;
  userId: string;
  idempotentReplay?: boolean;
  responsePayload?: Record<string, unknown>;
};

const HEADER_NAME = 'idempotency-key';
const MAX_KEY_LENGTH = 256;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function readBodyKey(body: Record<string, unknown>): string | null {
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey === 'string') return idempotencyKey;

  const requestId = body.requestId;
  return typeof requestId === 'string' ? requestId : null;
}

function normalizeKey(value: string, source: string): string {
  const key = value.trim();
  if (!key) {
    throw new AiUsageLedgerError(
      `${source} idempotency key cannot be blank.`,
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new AiUsageLedgerError(
      `${source} idempotency key must be ${MAX_KEY_LENGTH} characters or fewer.`,
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }

  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getAiUsageLedgerIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
): string | null {
  const headerValue = request.headers.get(HEADER_NAME);
  const bodyValue = readBodyKey(body);

  const headerKey = headerValue === null ? null : normalizeKey(headerValue, 'Header');
  const bodyKey = bodyValue === null ? null : normalizeKey(bodyValue, 'Request');

  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new AiUsageLedgerError(
      'Idempotency-Key header and request body idempotency key must match.',
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
    );
  }

  return headerKey ?? bodyKey;
}

export function hashAiUsageLedgerIdempotencyKey(userId: string, feature: string, key: string): string {
  return createHash('sha256')
    .update(userId)
    .update('\0')
    .update(feature)
    .update('\0')
    .update(key)
    .digest('hex');
}

export function buildAiUsageReplayResponse(ledger: AiUsageLedger): Record<string, unknown> {
  return {
    ...(ledger.responsePayload ?? {}),
    remainingCredits: ledger.remainingCredits,
    idempotentReplay: true,
  };
}

export async function startAiUsageLedger(
  client: SupabaseClient,
  input: AiUsageLedgerStartInput,
): Promise<AiUsageLedger> {
  const clientRequestKeyHash = input.idempotencyKey
    ? hashAiUsageLedgerIdempotencyKey(input.userId, input.feature, input.idempotencyKey)
    : null;

  const { data, error } = await client.rpc('start_ai_usage_event', {
    p_user_id: input.userId,
    p_cost: input.cost,
    p_feature: input.feature,
    p_provider: input.provider,
    p_model: input.model,
    p_medium: input.medium,
    p_input_prompt: input.inputPrompt,
    p_client_request_key_hash: clientRequestKeyHash,
  });

  if (error || !isRecord(data)) {
    throw new AiUsageLedgerError(
      errorMessage(error, 'Failed to start AI usage.'),
      500,
      'USAGE_EVENT_FAILED',
    );
  }

  const status = typeof data.status === 'string' ? data.status : null;
  const eventId = typeof data.event_id === 'string' ? data.event_id : null;
  const remainingCredits = typeof data.remaining_credits === 'number' ? data.remaining_credits : null;
  const cost = typeof data.cost === 'number' ? data.cost : input.cost;

  if (status === 'invalid_cost' || status === 'invalid_request') {
    throw new AiUsageLedgerError(
      'AI usage request is invalid.',
      400,
      'INVALID_AI_USAGE_REQUEST',
    );
  }

  if (status === 'profile_not_found') {
    throw new AiUsageLedgerError(
      'Could not find a credit profile for this account.',
      401,
      'AI_USAGE_PROFILE_NOT_FOUND',
    );
  }

  if (status === 'insufficient_credits') {
    throw new AiUsageLedgerError(
      `Insufficient credits. This action costs ${input.cost} credits.`,
      402,
      'INSUFFICIENT_CREDITS',
      typeof data.required_credits === 'number' ? data.required_credits : input.cost,
    );
  }

  if (status === 'in_progress') {
    throw new AiUsageLedgerError(
      'A paid AI request with this idempotency key is already running. Retry shortly.',
      409,
      'AI_USAGE_IN_PROGRESS',
    );
  }

  if (status === 'succeeded_replay') {
    if (!isRecord(data.response_payload)) {
      throw new AiUsageLedgerError(
        'This paid AI request already completed, but its replay response is unavailable.',
        409,
        'AI_USAGE_REPLAY_UNAVAILABLE',
      );
    }

    return {
      eventId: eventId ?? '',
      remainingCredits: remainingCredits ?? 0,
      cost,
      userId: input.userId,
      idempotentReplay: true,
      responsePayload: data.response_payload,
    };
  }

  if (status === 'key_already_used') {
    throw new AiUsageLedgerError(
      'This idempotency key was already used by a failed or refunded paid AI request. Retry with a new key.',
      409,
      'AI_USAGE_KEY_ALREADY_USED',
    );
  }

  if (status === 'invalid_idempotency_key') {
    throw new AiUsageLedgerError(
      'AI usage idempotency key is invalid.',
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }

  if (status !== 'started' || !eventId || typeof remainingCredits !== 'number') {
    throw new AiUsageLedgerError(
      'Failed to start AI usage.',
      500,
      'USAGE_EVENT_FAILED',
    );
  }

  return {
    eventId,
    remainingCredits,
    cost,
    userId: input.userId,
  };
}

export async function markAiUsageSucceeded(
  client: SupabaseClient,
  ledger: AiUsageLedger,
  outputText: string,
  responsePayload?: Record<string, unknown>,
) {
  const update: Record<string, unknown> = {
    status: 'succeeded',
    output_text: outputText.slice(0, 5000),
  };

  if (responsePayload) {
    update.response_payload = responsePayload;
  }

  await client
    .from('ai_usage_events')
    .update(update)
    .eq('id', ledger.eventId);
}

export async function refundAiUsageLedger(
  client: SupabaseClient,
  ledger: AiUsageLedger,
  error: unknown,
) {
  await client.rpc('refund_ai_usage_event', { p_event_id: ledger.eventId });
  await client
    .from('ai_usage_events')
    .update({
      error_message: errorMessage(error, 'Unknown error').slice(0, 1000),
    })
    .eq('id', ledger.eventId);
}
