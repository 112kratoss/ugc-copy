import { describe, expect, it, vi } from 'vitest';

import {
  getGenerationStartIdempotencyKey,
  hashGenerationStartIdempotencyKey,
  hashGenerationStartRequest,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';

type GenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string | null;
  status?: string | null;
  cost: number | null;
  client_request_key_hash: string | null;
};

type ProfileRow = {
  id: string;
  credits: number;
};

function createClient(options: {
  generations?: GenerationRow[];
  profiles?: ProfileRow[];
  lockAcquired?: boolean;
  claimResult?: 'claimed' | 'payload_mismatch';
}) {
  const generations = options.generations ?? [];
  const profiles = options.profiles ?? [{ id: 'user-1', credits: 42 }];
  const lockAcquired = options.lockAcquired ?? true;
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'claim_generation_start_request') {
      return { data: options.claimResult ?? 'claimed', error: null };
    }
    if (fn === 'try_acquire_backend_job_lock') {
      return { data: lockAcquired, error: null };
    }
    if (fn === 'release_backend_job_lock') {
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });

  const client = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === 'generations') return createChain(generations);
      if (table === 'profiles') return createChain(profiles);
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return { client, rpc };
}

function createChain<T>(rows: T[]) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push({ column, value });
      return chain;
    }),
    maybeSingle: vi.fn(async () => ({
      data: rows.find((row) => filters.every((filter) =>
        (row as Record<string, unknown>)[filter.column] === filter.value
      )) ?? null,
      error: null,
    })),
  };
  return chain;
}

describe('generation start idempotency', () => {
  it('normalizes matching header and body keys', () => {
    const request = new Request('http://localhost/api/generate-image', {
      headers: { 'Idempotency-Key': '  start-1  ' },
    });

    expect(getGenerationStartIdempotencyKey(request, { idempotencyKey: 'start-1' })).toBe('start-1');
  });

  it('requires an explicit idempotency key instead of accepting a trace id', () => {
    const request = new Request('http://localhost/api/generate-image', {
      headers: { 'x-request-id': ' mobile:retry-safe-1 ' },
    });

    expect(() => getGenerationStartIdempotencyKey(request, {})).toThrow(expect.objectContaining({
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    }));
  });

  it('prefers explicit idempotency keys over x-request-id fallback keys', () => {
    const request = new Request('http://localhost/api/generate-image', {
      headers: {
        'Idempotency-Key': 'start-explicit-1',
        'x-request-id': 'mobile:trace-only-1',
      },
    });

    expect(getGenerationStartIdempotencyKey(request, {})).toBe('start-explicit-1');
  });

  it('does not treat even a valid-looking x-request-id as a generation key', () => {
    const request = new Request('http://localhost/api/generate-image', {
      headers: { 'x-request-id': 'trace-only-1' },
    });

    expect(() => getGenerationStartIdempotencyKey(request, {})).toThrow(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    }));
  });

  it('hashes semantically identical request bodies consistently', () => {
    expect(hashGenerationStartRequest({
      prompt: 'hello',
      options: { seed: 7, aspectRatio: '16:9' },
      idempotencyKey: 'one',
    })).toBe(hashGenerationStartRequest({
      requestId: 'two',
      options: { aspectRatio: '16:9', seed: 7 },
      prompt: 'hello',
    }));
  });

  it('replays an existing generation without running the start function', async () => {
    const keyHash = hashGenerationStartIdempotencyKey('user-1', 'start-1');
    const { client, rpc } = createClient({
      generations: [{
        id: 'gen-1',
        user_id: 'user-1',
        prediction_id: 'task-1',
        cost: 8,
        client_request_key_hash: keyHash,
      }],
      profiles: [{ id: 'user-1', credits: 34 }],
    });
    const start = vi.fn();

    const result = await withGenerationStartIdempotency({
      client: client as never,
      userId: 'user-1',
      idempotencyKey: 'start-1',
      requestHash: hashGenerationStartRequest({ prompt: 'first' }),
      owner: 'request-1',
      start,
    });

    expect(result).toMatchObject({
      idempotentReplay: true,
      predictionId: 'task-1',
      generationId: 'gen-1',
      remainingCredits: 34,
      cost: 8,
    });
    expect(start).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
  });

  it('returns a conflict when the same key is already starting', async () => {
    const { client } = createClient({ lockAcquired: false });

    await expect(withGenerationStartIdempotency({
      client: client as never,
      userId: 'user-1',
      idempotencyKey: 'start-1',
      requestHash: hashGenerationStartRequest({ prompt: 'first' }),
      owner: 'request-1',
      start: vi.fn(),
    })).rejects.toMatchObject({
      status: 409,
      code: 'GENERATION_START_IN_PROGRESS',
    });
  });

  it('returns a conflict when a local generation row is already starting without a provider id', async () => {
    const keyHash = hashGenerationStartIdempotencyKey('user-1', 'start-pending');
    const { client, rpc } = createClient({
      generations: [{
        id: 'gen-pending-1',
        user_id: 'user-1',
        prediction_id: null,
        status: 'pending',
        cost: 8,
        client_request_key_hash: keyHash,
      }],
    });
    const start = vi.fn(async () => ({
      predictionId: 'task-duplicate',
      generationId: 'gen-duplicate',
      remainingCredits: 34,
      cost: 8,
    }));

    await expect(withGenerationStartIdempotency({
      client: client as never,
      userId: 'user-1',
      idempotencyKey: 'start-pending',
      requestHash: hashGenerationStartRequest({ prompt: 'pending' }),
      owner: 'request-1',
      start,
    })).rejects.toMatchObject({
      status: 409,
      code: 'GENERATION_START_IN_PROGRESS',
    });

    expect(start).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
  });

  it('passes a stable hash into the start function when no previous generation exists', async () => {
    const { client } = createClient({});
    const start = vi.fn(async (keyHash: string | null) => ({
      predictionId: 'task-2',
      generationId: 'gen-2',
      remainingCredits: 26,
      cost: 8,
      keyHash,
    }));

    const result = await withGenerationStartIdempotency({
      client: client as never,
      userId: 'user-1',
      idempotencyKey: 'start-2',
      requestHash: hashGenerationStartRequest({ prompt: 'second' }),
      owner: 'request-2',
      start,
    });

    expect(result).toMatchObject({
      predictionId: 'task-2',
      generationId: 'gen-2',
      remainingCredits: 26,
      cost: 8,
    });
    expect(start).toHaveBeenCalledWith(hashGenerationStartIdempotencyKey('user-1', 'start-2'));
  });

  it('rejects reusing an idempotency key for a different request payload', async () => {
    const { client, rpc } = createClient({ claimResult: 'payload_mismatch' });
    const start = vi.fn();

    await expect(withGenerationStartIdempotency({
      client: client as never,
      userId: 'user-1',
      idempotencyKey: 'start-reused',
      requestHash: hashGenerationStartRequest({ prompt: 'different' }),
      owner: 'request-3',
      start,
    })).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect(start).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
  });
});
