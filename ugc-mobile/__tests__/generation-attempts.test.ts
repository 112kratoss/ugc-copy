import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

import { ApiError } from '../lib/api-client';
import {
  clearGenerationAttemptForUser,
  clearPendingGenerationAttempt,
  generationStartRefusalCode,
  isAmbiguousGenerationStartFailure,
  loadPendingGenerationAttempt,
  pendingGenerationAttemptStorageKey,
  PENDING_GENERATION_ATTEMPT_MAX_AGE_MS,
  reusableAttemptKey,
  savePendingGenerationAttempt,
  type PendingGenerationAttempt,
} from '../lib/generation-attempts';

const NOW = Date.parse('2026-09-16T10:00:00.000Z');

function attempt(overrides: Partial<PendingGenerationAttempt> = {}): PendingGenerationAttempt {
  return {
    version: 1,
    identityUserId: 'user-1',
    tool: 'video',
    route: 'unified',
    idempotencyKey: 'video:attempt-1',
    requestJson: JSON.stringify({ kind: 'video', modelId: 'seedance-2', prompt: 'A reveal' }),
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

describe('isAmbiguousGenerationStartFailure', () => {
  it.each([
    ['a lost connection', { status: 0 }],
    ['a server fault', { status: 503 }],
    ['a server fault the route could not classify', { status: 500, code: 'GENERATION_START_FAILED' }],
    ['a start still in flight under this key', { status: 409, code: 'GENERATION_START_IN_PROGRESS' }],
    ['a provider accept that was never confirmed', { status: 409, details: { code: 'submission_pending' } }],
    ['a held submission answered as a server fault', { status: 503, code: 'submission_pending' }],
    ['an adapter the start could not reach', { status: 503, code: 'GENERATION_ADAPTER_UNAVAILABLE' }],
  ])('treats %s as possibly started', (_label, error) => {
    expect(isAmbiguousGenerationStartFailure(error)).toBe(true);
  });

  it.each([
    ['a validation refusal', { status: 422, details: { code: 'INVALID_GENERATION_REQUEST' } }],
    ['too few credits', { status: 402 }],
    ['a rate limit', { status: 429 }],
    ['a reused key', { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' }],
    ['a measured reference that changed the price', { status: 409, details: { code: 'REFERENCE_DURATION_CHANGED' } }],
    ['an error that never reached the network', new Error('Could not build the request')],
    // A 5xx that names a refusal started nothing; read as unconfirmed, its "Check again"
    // replayed the same refusal (and, for a provider refusal, a new hold) every time.
    ['a provider that is unavailable', { status: 503, code: 'provider_unavailable' }],
    ['a service that is not set up', { status: 503, details: { code: 'service_misconfigured' } }],
    ['a route without its provider key', { status: 503, code: 'GENERATION_SERVICE_UNAVAILABLE' }],
    ['a provider that refused the task', { status: 422, code: 'provider_rejected' }],
    ['a blocked prompt', { status: 422, code: 'prompt_blocked' }],
    ['a busy provider', { status: 429, code: 'provider_busy' }],
    ['the start rate limit', { status: 429, code: 'RATE_LIMITED' }],
    ['a price that changed', { status: 409, code: 'cost_changed' }],
  ])('treats %s as definitive', (_label, error) => {
    expect(isAmbiguousGenerationStartFailure(error)).toBe(false);
  });
});

describe('generationStartRefusalCode', () => {
  it('names the refusal the failure view chooses its action by, from the error the API client throws', () => {
    const refusal = (status: number, code?: string) => new ApiError('Refused.', status, code ? { code, error: 'Refused.' } : { error: 'Refused.' }, 'request-1', code);

    expect(generationStartRefusalCode(refusal(422, 'prompt_blocked'))).toBe('prompt_blocked');
    expect(generationStartRefusalCode(refusal(402, 'insufficient_credits'))).toBe('insufficient_credits');
    expect(generationStartRefusalCode(refusal(422, 'invalid_input_media'))).toBe('invalid_input_media');
    expect(generationStartRefusalCode(refusal(409, 'cost_changed'))).toBe('cost_changed');
    expect(generationStartRefusalCode(refusal(409, 'CATALOG_CHANGED'))).toBe('CATALOG_CHANGED');
    expect(generationStartRefusalCode(refusal(503, 'provider_unavailable'))).toBe('provider_unavailable');
    // Read off the body when the client kept no code of its own.
    expect(generationStartRefusalCode({ status: 422, details: { code: 'provider_rejected' } })).toBe('provider_rejected');
  });

  it('reads a server from before every refusal had a code by its status', () => {
    expect(generationStartRefusalCode({ status: 402 })).toBe('insufficient_credits');
    expect(generationStartRefusalCode({ status: 429 })).toBe('provider_busy');
    expect(generationStartRefusalCode({ status: 422 })).toBeNull();
  });

  it('names nothing for a start that may have begun, or an error that never reached the server', () => {
    expect(generationStartRefusalCode({ status: 0 })).toBeNull();
    expect(generationStartRefusalCode({ status: 500, code: 'GENERATION_START_FAILED' })).toBeNull();
    expect(generationStartRefusalCode({ status: 409, code: 'submission_pending' })).toBeNull();
    expect(generationStartRefusalCode(new Error('Could not build the request'))).toBeNull();
    expect(generationStartRefusalCode(null)).toBeNull();
  });
});

describe('reusableAttemptKey', () => {
  it('reuses the key only for the same identity, route and request', () => {
    const pending = attempt();

    expect(reusableAttemptKey(pending, 'user-1', 'unified', pending.requestJson)).toBe('video:attempt-1');
    expect(reusableAttemptKey(pending, 'user-2', 'unified', pending.requestJson)).toBeNull();
    expect(reusableAttemptKey(pending, 'user-1', 'video', pending.requestJson)).toBeNull();
    expect(reusableAttemptKey(pending, 'user-1', 'unified', '{"prompt":"Edited"}')).toBeNull();
    expect(reusableAttemptKey(null, 'user-1', 'unified', pending.requestJson)).toBeNull();
  });
});

describe('pending generation attempt storage', () => {
  it('saves under the identity and loads it back', async () => {
    const storage = memoryStorage();
    const saved = attempt();

    await savePendingGenerationAttempt(saved, { storage });

    expect([...storage.values.keys()]).toEqual([pendingGenerationAttemptStorageKey('user-1')]);
    await expect(loadPendingGenerationAttempt('user-1', { storage, now: NOW })).resolves.toEqual(saved);
    await expect(loadPendingGenerationAttempt('user-2', { storage, now: NOW })).resolves.toBeNull();
  });

  it('drops an attempt that is too old, malformed, or someone else’s', async () => {
    const key = pendingGenerationAttemptStorageKey('user-1');
    for (const raw of [
      JSON.stringify(attempt({ createdAt: new Date(NOW - PENDING_GENERATION_ATTEMPT_MAX_AGE_MS - 1).toISOString() })),
      '{not json',
      JSON.stringify({ ...attempt(), idempotencyKey: '' }),
      JSON.stringify(attempt({ identityUserId: 'user-2' })),
    ]) {
      const storage = memoryStorage({ [key]: raw });

      await expect(loadPendingGenerationAttempt('user-1', { storage, now: NOW })).resolves.toBeNull();
      expect(storage.values.has(key)).toBe(false);
    }
  });

  it('clears only the identity’s own attempt', async () => {
    const storage = memoryStorage({
      [pendingGenerationAttemptStorageKey('user-1')]: JSON.stringify(attempt()),
      [pendingGenerationAttemptStorageKey('user-2')]: JSON.stringify(attempt({ identityUserId: 'user-2' })),
    });

    await clearPendingGenerationAttempt('user-1', { storage });

    expect([...storage.values.keys()]).toEqual([pendingGenerationAttemptStorageKey('user-2')]);
  });
});

describe('clearGenerationAttemptForUser (audit 04-7)', () => {
  it("forgets the account's saved generation and nobody else's", async () => {
    const storage = memoryStorage({
      [pendingGenerationAttemptStorageKey('user-1')]: JSON.stringify(attempt()),
      [pendingGenerationAttemptStorageKey('user-2')]: JSON.stringify(attempt({ identityUserId: 'user-2' })),
    });

    await clearGenerationAttemptForUser('user-1', { storage });

    expect([...storage.values.keys()]).toEqual([pendingGenerationAttemptStorageKey('user-2')]);
  });

  it('never fails the deletion over the saved request', async () => {
    const storage = memoryStorage();
    storage.removeItem.mockRejectedValueOnce(new Error('storage closed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(clearGenerationAttemptForUser('user-1', { storage })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
