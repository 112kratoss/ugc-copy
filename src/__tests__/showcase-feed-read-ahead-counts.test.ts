import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { recordShowcaseFeedReadAheadEvent } from '@/lib/showcase-feed-read-ahead-counts';

function clientAnswering(answer: () => Promise<{ error: { message: string } | null }>) {
  const rpc = vi.fn(answer);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('recordShowcaseFeedReadAheadEvent', () => {
  it('adds one to the event through the counter function', async () => {
    const { client, rpc } = clientAnswering(async () => ({ error: null }));
    const logWarning = vi.fn();

    await recordShowcaseFeedReadAheadEvent('claim', { createServiceClient: () => client, logWarning });

    expect(rpc).toHaveBeenCalledWith('record_showcase_feed_read_ahead_event', { p_event: 'claim' });
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('logs a count the database refused, and resolves', async () => {
    const { client } = clientAnswering(async () => ({ error: { message: 'function does not exist' } }));
    const logWarning = vi.fn();

    await expect(recordShowcaseFeedReadAheadEvent('hold', { createServiceClient: () => client, logWarning }))
      .resolves.toBeUndefined();

    expect(logWarning).toHaveBeenCalledWith('showcase_feed_read_ahead_count_failed', {
      event: 'hold',
      message: 'function does not exist',
    });
  });

  it('logs a count that could not be sent at all, and resolves', async () => {
    const logWarning = vi.fn();

    await expect(recordShowcaseFeedReadAheadEvent('claim_miss', {
      createServiceClient: () => { throw new Error('no service key'); },
      logWarning,
    })).resolves.toBeUndefined();
    const { client } = clientAnswering(async () => { throw new Error('socket closed'); });
    await expect(recordShowcaseFeedReadAheadEvent('claim_miss', { createServiceClient: () => client, logWarning }))
      .resolves.toBeUndefined();

    expect(logWarning.mock.calls).toEqual([
      ['showcase_feed_read_ahead_count_failed', { event: 'claim_miss', message: 'no service key' }],
      ['showcase_feed_read_ahead_count_failed', { event: 'claim_miss', message: 'socket closed' }],
    ]);
  });
});
