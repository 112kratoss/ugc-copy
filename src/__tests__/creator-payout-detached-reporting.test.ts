import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { listOpenCreatorPayoutRequests, listResolvedCreatorPayoutRequests } from '@/lib/creator-payout-ops';

const ACTIVE = '11000000-0000-4000-8000-000000000001';
const DELETED = '11000000-0000-4000-8000-000000000002';
const row = (userId: string | null) => ({
  id: userId ? 'active-request' : 'detached-request', user_id: userId,
  detached_user_id: userId ? null : DELETED,
  amount_token_subunits: 1_500_000, payout_method: 'upi', payout_details: 'synthetic@upi',
  status: 'paid', requested_at: '2026-09-01T00:00:00Z', resolved_at: '2026-09-02T00:00:00Z',
});

function fixture(rows: ReturnType<typeof row>[]) {
  const lookups: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    let data: unknown = rows;
    if (!url.pathname.endsWith('/creator_payout_requests')) {
      lookups.push(url);
      // Actual PostgREST UUID behavior, reproduced against production with a
      // read-only lookup: in.(null,<uuid>) returns 400 / 22P02 for the whole set.
      if (url.search.includes('null')) return new Response(JSON.stringify({code:'22P02',message:'invalid input syntax for type uuid: "null"'}),{status:400});
      data = url.pathname.endsWith('/profiles')
        ? [{id: ACTIVE, username: 'maker', display_name: 'Active Maker'}]
        : [{user_id: ACTIVE, lifetime_earned_token_subunits: 2_000_000}];
    }
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json','content-range':`0-${rows.length-1}/${rows.length}`}});
  });
  return {client:createClient('http://127.0.0.1:9999','fixture-key',{global:{fetch},auth:{persistSession:false}}),lookups};
}

describe('payout reporting after account deletion', () => {
  it('keeps active creator names and earnings in a mixed open queue', async () => {
    const {client,lookups}=fixture([row(ACTIVE),row(null)]);
    const result=await listOpenCreatorPayoutRequests(client);
    expect(result[0]).toMatchObject({userId:ACTIVE,displayName:'Active Maker',lifetimeEarnedTokenSubunits:2_000_000});
    expect(result[1]).toMatchObject({userId:null,detachedUserId:DELETED,lifetimeEarnedTokenSubunits:null,payoutDetails:'synthetic@upi'});
    expect(lookups.every(url=>!url.search.includes('null'))).toBe(true);
  });
  it('keeps active creator names and detached identities in mixed history', async () => {
    const {client}=fixture([row(ACTIVE),row(null)]);
    const result=await listResolvedCreatorPayoutRequests(client);
    expect(result.requests[0]).toMatchObject({userId:ACTIVE,displayName:'Active Maker'});
    expect(result.requests[1]).toMatchObject({userId:null,detachedUserId:DELETED});
    expect(result.total).toBe(2);
  });
  it('does not query deleted profiles or wallets for an entirely detached queue', async () => {
    const {client,lookups}=fixture([row(null)]);
    await listOpenCreatorPayoutRequests(client);
    await listResolvedCreatorPayoutRequests(client);
    expect(lookups).toEqual([]);
  });
});
