import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

import {
  clearPendingGenerationAttempt,
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
    ['a start still in flight under this key', { status: 409, code: 'GENERATION_START_IN_PROGRESS' }],
    ['a provider accept that was never confirmed', { status: 409, details: { code: 'submission_pending' } }],
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
  ])('treats %s as definitive', (_label, error) => {
    expect(isAmbiguousGenerationStartFailure(error)).toBe(false);
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
