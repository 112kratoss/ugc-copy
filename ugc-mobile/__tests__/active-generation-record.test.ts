import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

import {
  ACTIVE_GENERATION_RECORD_MAX_AGE_MS,
  activeGenerationRecordStorageKey,
  clearActiveGenerationRecord,
  loadActiveGenerationRecord,
  saveActiveGenerationRecord,
  type ActiveGenerationRecord,
} from '../lib/active-generation-record';

const NOW = Date.parse('2026-10-13T10:00:00.000Z');

function record(overrides: Partial<ActiveGenerationRecord> = {}): ActiveGenerationRecord {
  return {
    version: 1,
    identityUserId: 'user-1',
    tool: 'video',
    predictionId: 'prediction-1',
    generationId: 'generation-1',
    startedAt: NOW - 5 * 60_000,
    estimatedTotalMs: 180_000,
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

describe('the active run a creator screen resumes', () => {
  it('is kept under the identity’s own key and read back by that identity alone', async () => {
    const storage = memoryStorage();
    const saved = record();

    await saveActiveGenerationRecord(saved, { storage });

    expect([...storage.values.keys()]).toEqual(['magicbooklet.generation.activeRun.v1:user-1']);
    expect(activeGenerationRecordStorageKey('user-1')).toBe('magicbooklet.generation.activeRun.v1:user-1');
    await expect(loadActiveGenerationRecord('user-1', { storage, now: NOW })).resolves.toEqual(saved);
    await expect(loadActiveGenerationRecord('user-2', { storage, now: NOW })).resolves.toBeNull();
  });

  it('keeps a run without a generation id or an estimate', async () => {
    const storage = memoryStorage();
    const saved = record({ tool: 'image', generationId: null, estimatedTotalMs: null });

    await saveActiveGenerationRecord(saved, { storage });

    await expect(loadActiveGenerationRecord('user-1', { storage, now: NOW })).resolves.toEqual(saved);
  });

  it('is not resumed past two hours, and is removed then', async () => {
    const key = activeGenerationRecordStorageKey('user-1');
    const recent = memoryStorage({ [key]: JSON.stringify(record({ startedAt: NOW - ACTIVE_GENERATION_RECORD_MAX_AGE_MS })) });
    const stale = memoryStorage({ [key]: JSON.stringify(record({ startedAt: NOW - ACTIVE_GENERATION_RECORD_MAX_AGE_MS - 1 })) });

    await expect(loadActiveGenerationRecord('user-1', { storage: recent, now: NOW })).resolves.not.toBeNull();
    await expect(loadActiveGenerationRecord('user-1', { storage: stale, now: NOW })).resolves.toBeNull();
    expect(stale.values.has(key)).toBe(false);
  });

  it('removes one that is unreadable or someone else’s rather than resuming it', async () => {
    const key = activeGenerationRecordStorageKey('user-1');
    for (const raw of [
      '{not json',
      JSON.stringify({ ...record(), version: 2 }),
      JSON.stringify(record({ identityUserId: 'user-2' })),
      JSON.stringify({ ...record(), tool: 'audio' }),
      JSON.stringify(record({ predictionId: '' })),
      JSON.stringify({ ...record(), startedAt: '2026-10-13T09:55:00.000Z' }),
      JSON.stringify({ ...record(), estimatedTotalMs: 'soon' }),
    ]) {
      const storage = memoryStorage({ [key]: raw });

      await expect(loadActiveGenerationRecord('user-1', { storage, now: NOW })).resolves.toBeNull();
      expect(storage.values.has(key)).toBe(false);
    }
  });

  it('clears only the identity’s own run', async () => {
    const storage = memoryStorage({
      [activeGenerationRecordStorageKey('user-1')]: JSON.stringify(record()),
      [activeGenerationRecordStorageKey('guest-1')]: JSON.stringify(record({ identityUserId: 'guest-1' })),
    });

    await clearActiveGenerationRecord('user-1', { storage });

    expect([...storage.values.keys()]).toEqual([activeGenerationRecordStorageKey('guest-1')]);
  });
});
