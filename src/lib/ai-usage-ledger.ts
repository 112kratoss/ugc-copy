import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

export class AiUsageLedgerError extends Error {
  status: number;
  code:
    | 'CREDIT_DEDUCTION_FAILED'
    | 'INSUFFICIENT_CREDITS'
    | 'USAGE_EVENT_FAILED'
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
const ACTIVE_USAGE_STATUSES = new Set(['pending']);

type ExistingUsageEventRow = {
  id: string;
  status: string | null;
  cost: number | null;
  response_payload: unknown;
};

type ProfileCreditsRow = {
  credits: number | null;
};

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

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === '23505') return true;

  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message.toLowerCase().includes('duplicate key');
}

async function refundCreditsQuietly(client: SupabaseClient, userId: string, amount: number) {
  try {
    await client.rpc('refund_credits', { p_user_id: userId, p_amount: amount });
  } catch (error) {
    console.error('Failed to refund AI usage credits after ledger error:', error);
  }
}

async function loadCurrentCredits(client: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await client
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  const row = data as ProfileCreditsRow | null;
  return typeof row?.credits === 'number' ? row.credits : 0;
}

async function loadExistingUsageEvent(params: {
  client: SupabaseClient;
  input: AiUsageLedgerStartInput;
  keyHash: string;
}): Promise<AiUsageLedger | null> {
  const { data, error } = await params.client
    .from('ai_usage_events')
    .select('id,status,cost,response_payload')
    .eq('user_id', params.input.userId)
    .eq('feature', params.input.feature)
    .eq('client_request_key_hash', params.keyHash)
    .maybeSingle();

  if (error) throw error;

  const row = data as ExistingUsageEventRow | null;
  if (!row) return null;

  if (ACTIVE_USAGE_STATUSES.has(row.status ?? '')) {
    throw new AiUsageLedgerError(
      'A paid AI request with this idempotency key is already running. Retry shortly.',
      409,
      'AI_USAGE_IN_PROGRESS',
    );
  }

  if (row.status === 'succeeded') {
    if (!isRecord(row.response_payload)) {
      throw new AiUsageLedgerError(
        'This paid AI request already completed, but its replay response is unavailable.',
        409,
        'AI_USAGE_REPLAY_UNAVAILABLE',
      );
    }

    return {
      eventId: row.id,
      remainingCredits: await loadCurrentCredits(params.client, params.input.userId),
      cost: typeof row.cost === 'number' ? row.cost : params.input.cost,
      userId: params.input.userId,
      idempotentReplay: true,
      responsePayload: row.response_payload,
    };
  }

  throw new AiUsageLedgerError(
    'This idempotency key was already used by a failed or refunded paid AI request. Retry with a new key.',
    409,
    'AI_USAGE_KEY_ALREADY_USED',
  );
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

  if (clientRequestKeyHash) {
    const existing = await loadExistingUsageEvent({
      client,
      input,
      keyHash: clientRequestKeyHash,
    });
    if (existing) return existing;
  }

  const { data: remainingCredits, error: deductError } = await client.rpc('deduct_credits', {
    p_user_id: input.userId,
    p_cost: input.cost,
  });

  if (deductError) {
    throw new AiUsageLedgerError(
      errorMessage(deductError, 'Failed to deduct credits.'),
      500,
      'CREDIT_DEDUCTION_FAILED',
    );
  }

  if (remainingCredits === -1) {
    throw new AiUsageLedgerError(
      `Insufficient credits. This action costs ${input.cost} credits.`,
      402,
      'INSUFFICIENT_CREDITS',
      input.cost,
    );
  }

  const { data: usageEvent, error: insertError } = await client
    .from('ai_usage_events')
    .insert({
      user_id: input.userId,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      medium: input.medium,
      cost: input.cost,
      status: 'pending',
      input_prompt: input.inputPrompt.slice(0, 5000),
      client_request_key_hash: clientRequestKeyHash,
    })
    .select('id')
    .single();

  const eventId = typeof usageEvent?.id === 'string' ? usageEvent.id : null;
  if (insertError || !eventId) {
    await refundCreditsQuietly(client, input.userId, input.cost);
    if (isUniqueViolation(insertError)) {
      throw new AiUsageLedgerError(
        'A paid AI request with this idempotency key is already running. Retry shortly.',
        409,
        'AI_USAGE_IN_PROGRESS',
      );
    }

    throw new AiUsageLedgerError(
      'Failed to record AI usage.',
      500,
      'USAGE_EVENT_FAILED',
    );
  }

  return {
    eventId,
    remainingCredits: Number(remainingCredits),
    cost: input.cost,
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
