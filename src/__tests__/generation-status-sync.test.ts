// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import {
  announceGenerationStatusSynced,
  subscribeToGenerationStatusSynced,
  type GenerationStatusSyncRecord,
} from '@/lib/generation-status-client';

function buildRecord(overrides: Partial<GenerationStatusSyncRecord> = {}): GenerationStatusSyncRecord {
  return {
    id: 'gen-1',
    status: 'processing',
    created_at: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('generation status sync broadcast', () => {
  it('delivers announced records to subscribers', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToGenerationStatusSynced(callback);

    const records = [buildRecord(), buildRecord({ id: 'gen-2', status: 'succeeded' })];
    announceGenerationStatusSynced(records);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(records);

    unsubscribe();
  });

  it('filters malformed entries and skips empty payloads', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToGenerationStatusSynced(callback);

    announceGenerationStatusSynced([
      buildRecord(),
      { id: 42, status: 'processing' } as unknown as GenerationStatusSyncRecord,
      null as unknown as GenerationStatusSyncRecord,
    ]);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toHaveLength(1);

    callback.mockClear();
    announceGenerationStatusSynced([
      { status: 'processing' } as unknown as GenerationStatusSyncRecord,
    ]);
    expect(callback).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToGenerationStatusSynced(callback);

    unsubscribe();
    announceGenerationStatusSynced([buildRecord()]);

    expect(callback).not.toHaveBeenCalled();
  });
});
