import { describe, expect, it } from 'vitest';
import { deferMediaRepairCapacity, mediaRepairAttemptAfterFailure } from '@/lib/media-repair-capacity';
import { StagingCapacityError } from '@/lib/staging-workspace';
import { createStoredRows } from './fixtures/stored-rows';

describe.each(['teaser', 'playback_rendition'] as const)('%s capacity deferral', kind => {
  function fixture() {
    const table = kind === 'teaser' ? 'post_media' : 'generations';
    const sourceColumn = kind === 'teaser' ? 'rendition_storage_path' : 'output_url';
    const row: Record<string, unknown> = { id: 'media', [sourceColumn]: 'original',
      [`${kind}_locked_by`]: 'owner', [`${kind}_locked_at`]: 'locked',
      [`${kind}_attempt_count`]: 3, [`${kind}_status`]: 'processing' };
    const { client } = createStoredRows({ [table]: [row] });
    const args = { supabase: client, error: new StagingCapacityError(), kind, id: 'media', lockedBy: 'owner', source: 'original' };
    return { row, args, sourceColumn };
  }
  it('restores only the refused attempt and duplicate deferral cannot decrement again', async () => {
    const { row, args } = fixture();
    expect(await deferMediaRepairCapacity(args)).toBe(true);
    expect(row[`${kind}_attempt_count`]).toBe(2);
    expect(row[`${kind}_locked_by`]).toBeNull();
    expect(row[`${kind}_error`]).toContain('deferred');
    expect(await deferMediaRepairCapacity(args)).toBe(true);
    expect(row[`${kind}_attempt_count`]).toBe(2);
  });
  it.each(['lease', 'source'])('does not change a replaced %s', async changed => {
    const { row, args, sourceColumn } = fixture();
    row[changed === 'lease' ? `${kind}_locked_by` : sourceColumn] = 'replacement';
    expect(await deferMediaRepairCapacity(args)).toBe(true);
    expect(row[`${kind}_attempt_count`]).toBe(3);
    expect(row[`${kind}_locked_at`]).toBe('locked');
  });
  it('retains ordinary encoding failures as consumed attempts', async () => {
    const { row, args } = fixture();
    expect(await deferMediaRepairCapacity({ ...args, error: new Error('decode failed') })).toBe(false);
    expect(row[`${kind}_attempt_count`]).toBe(3);
  });
});
it('restores preview/rendition admission attempts without changing real failure accounting', () => {
  expect(mediaRepairAttemptAfterFailure(new StagingCapacityError(), 3)).toBe(2);
  expect(mediaRepairAttemptAfterFailure(new Error('decode failed'), 3)).toBe(3);
});
