import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { processPendingMobilePushReceipts } from '@/lib/mobile-notifications';

function fixture({ fail, stale = false }: { fail: 'receipt' | 'token'; stale?: boolean }) {
  const writes: string[] = [];
  const pending = {
    select: () => pending, eq: () => pending, lte: () => pending, order: () => pending,
    limit: async () => ({ data: [{ id: 'delivery', token_id: 'token', push_ticket_id: 'ticket', receipt_status: 'pending', sent_at: stale ? '2026-10-01T00:00:00Z' : '2026-10-02T11:00:00Z' }], error: null }),
  };
  const tokenUpdate = {
    in: () => tokenUpdate, eq: () => tokenUpdate,
    select: async () => { writes.push('token'); return { data: fail === 'token' ? null : [{ id: 'token' }], error: fail === 'token' ? { message: 'Token update failed' } : null }; },
  };
  const client = { from: (table: string) => {
    if (table === 'mobile_push_tokens') return { update: () => tokenUpdate };
    if (table === 'mobile_push_deliveries') return {
      ...pending,
      update: () => ({ eq: async () => { writes.push('receipt'); return { data: null, error: fail === 'receipt' ? { message: 'Receipt update failed' } : null }; } }),
    };
    throw new Error('Unexpected table: ' + table);
  } } as unknown as SupabaseClient;
  return { client, writes };
}
const provider = (unregistered: boolean) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: {
  ticket: unregistered ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' },
} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const now = new Date('2026-10-02T12:00:00Z');

describe('receipt maintenance write failures', () => {
  it.each([false, true])('rejects failed receipt persistence (stale=%s)', async (stale) => {
    const { client, writes } = fixture({ fail: 'receipt', stale });
    const fetcher = provider(false);
    await expect(processPendingMobilePushReceipts(client, { fetcher, now })).rejects.toThrow(stale ? 'Failed to mark push receipt stale.' : 'Failed to record push receipt.');
    expect(writes).toEqual(['receipt']);
    expect(fetcher).toHaveBeenCalledTimes(stale ? 0 : 1);
  });

  it('does not finalize the receipt when token retirement fails', async () => {
    const { client, writes } = fixture({ fail: 'token' });
    await expect(processPendingMobilePushReceipts(client, { fetcher: provider(true), now })).rejects.toThrow('Failed to retire unregistered push tokens.');
    expect(writes).toEqual(['token']);
  });

  it('retires the token before finalizing a DeviceNotRegistered receipt', async () => {
    const { client, writes } = fixture({ fail: 'receipt' });
    await expect(processPendingMobilePushReceipts(client, { fetcher: provider(true), now })).rejects.toThrow('Failed to record push receipt.');
    expect(writes).toEqual(['token', 'receipt']);
  });
});
