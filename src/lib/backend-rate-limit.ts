import { NextResponse } from 'next/server';

type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

export type BackendRateLimitOptions = {
  scope: string;
  key: string;
  limit: number;
  windowSeconds: number;
};

export type BackendRateLimitState = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: string;
};

export const MEDIA_GENERATION_RATE_LIMIT = {
  scope: 'media-generation:start',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const PROMPT_ENHANCEMENT_RATE_LIMIT = {
  scope: 'prompt-enhancement',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_ASSISTANT_RATE_LIMIT = {
  scope: 'workflow-assistant',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_BLUEPRINT_RATE_LIMIT = {
  scope: 'workflow-blueprint',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const SEEDANCE_ASSET_RATE_LIMIT = {
  scope: 'seedance-assets:create',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_RUN_RATE_LIMIT = {
  scope: 'workflow-run:start',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export class BackendRateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;
  state: BackendRateLimitState;

  constructor(state: BackendRateLimitState) {
    super('Too many requests. Please wait before trying again.');
    this.name = 'BackendRateLimitError';
    this.retryAfterSeconds = state.retryAfterSeconds;
    this.state = state;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRateLimitState(value: unknown): BackendRateLimitState {
  if (!isRecord(value)) {
    throw new Error('Rate limit response was invalid');
  }

  return {
    allowed: value.allowed === true,
    limit: Number(value.limit ?? 0),
    remaining: Math.max(0, Number(value.remaining ?? 0)),
    retryAfterSeconds: Math.max(0, Number(value.retryAfterSeconds ?? 0)),
    resetAt: typeof value.resetAt === 'string' ? value.resetAt : new Date().toISOString(),
  };
}

export async function enforceBackendRateLimit(
  client: SupabaseRpcClient,
  options: BackendRateLimitOptions,
): Promise<BackendRateLimitState> {
  if (!options.scope.trim()) throw new Error('Rate limit scope is required');
  if (!options.key.trim()) throw new Error('Rate limit key is required');
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('Rate limit must be a positive integer');
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1) {
    throw new Error('Rate limit window must be a positive integer');
  }

  const result = await client.rpc('check_backend_rate_limit', {
    p_scope: options.scope,
    p_subject_key: options.key,
    p_limit: options.limit,
    p_window_seconds: options.windowSeconds,
  });

  if (result.error) throw result.error;

  const state = normalizeRateLimitState(result.data);
  if (!state.allowed) {
    throw new BackendRateLimitError(state);
  }

  return state;
}

export function createBackendRateLimitResponse(error: BackendRateLimitError) {
  return NextResponse.json({
    error: error.message,
    code: 'RATE_LIMITED',
    retryAfterSeconds: error.retryAfterSeconds,
    limit: error.state.limit,
    resetAt: error.state.resetAt,
  }, {
    status: error.status,
    headers: {
      'Retry-After': String(error.retryAfterSeconds),
      'X-RateLimit-Limit': String(error.state.limit),
      'X-RateLimit-Remaining': String(error.state.remaining),
      'X-RateLimit-Reset': error.state.resetAt,
    },
  });
}
