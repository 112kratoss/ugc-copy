import { createHash, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { withBackendJobLock } from '@/lib/backend-job-lock';

const HEADER_NAME = 'idempotency-key';
const MAX_KEY_LENGTH = 256;
const LOCK_TTL_SECONDS = 120;

export type GenerationStartResult = {
  predictionId: string;
  remainingCredits: number;
  cost: number;
  generationId?: string | null;
  idempotentReplay?: boolean;
};

type ExistingGenerationRow = {
  id: string;
  prediction_id: string | null;
  cost: number | null;
};

type ProfileCreditsRow = {
  credits: number | null;
};

export class GenerationStartIdempotencyError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'GenerationStartIdempotencyError';
    this.status = status;
    this.code = code;
  }
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
    throw new GenerationStartIdempotencyError(
      `${source} idempotency key cannot be blank.`,
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new GenerationStartIdempotencyError(
      `${source} idempotency key must be ${MAX_KEY_LENGTH} characters or fewer.`,
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  }

  return key;
}

export function getGenerationStartIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
): string | null {
  const headerValue = request.headers.get(HEADER_NAME);
  const bodyValue = readBodyKey(body);

  const headerKey = headerValue === null ? null : normalizeKey(headerValue, 'Header');
  const bodyKey = bodyValue === null ? null : normalizeKey(bodyValue, 'Request');

  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new GenerationStartIdempotencyError(
      'Idempotency-Key header and request body idempotency key must match.',
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
    );
  }

  return headerKey ?? bodyKey;
}

export function getGenerationStartLockOwner(request: Request): string {
  return `${request.headers.get('x-vercel-id') ?? randomUUID()}:${Date.now()}`;
}

export function hashGenerationStartIdempotencyKey(userId: string, key: string): string {
  return createHash('sha256')
    .update(userId)
    .update('\0')
    .update(key)
    .digest('hex');
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

async function loadExistingGeneration(
  client: SupabaseClient,
  userId: string,
  keyHash: string,
): Promise<GenerationStartResult | null> {
  const { data, error } = await client
    .from('generations')
    .select('id,prediction_id,cost')
    .eq('user_id', userId)
    .eq('client_request_key_hash', keyHash)
    .maybeSingle();

  if (error) throw error;

  const row = data as ExistingGenerationRow | null;
  if (!row?.prediction_id) return null;

  return {
    predictionId: row.prediction_id,
    generationId: row.id,
    cost: typeof row.cost === 'number' ? row.cost : 0,
    remainingCredits: await loadCurrentCredits(client, userId),
    idempotentReplay: true,
  };
}

export async function withGenerationStartIdempotency(params: {
  client: SupabaseClient;
  userId: string;
  idempotencyKey: string | null;
  owner: string;
  start: (keyHash: string | null) => Promise<GenerationStartResult>;
}): Promise<GenerationStartResult> {
  if (!params.idempotencyKey) {
    return params.start(null);
  }

  const keyHash = hashGenerationStartIdempotencyKey(params.userId, params.idempotencyKey);
  const existing = await loadExistingGeneration(params.client, params.userId, keyHash);
  if (existing) return existing;

  const lock = await withBackendJobLock(params.client, {
    name: `generation-start:${params.userId}:${keyHash}`,
    ttlSeconds: LOCK_TTL_SECONDS,
    owner: params.owner,
  }, async () => {
    const existingInsideLock = await loadExistingGeneration(params.client, params.userId, keyHash);
    if (existingInsideLock) return existingInsideLock;

    return params.start(keyHash);
  });

  if (!lock.acquired) {
    throw new GenerationStartIdempotencyError(
      'A generation with this idempotency key is already starting. Retry shortly.',
      409,
      'GENERATION_START_IN_PROGRESS',
    );
  }

  return lock.value;
}
