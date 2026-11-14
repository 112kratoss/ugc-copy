import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { getAdminUserDetail, searchAdminUsers } from '@/lib/admin-users-service';

const USER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';

type TableRows = Record<string, Array<Record<string, unknown>> | Record<string, unknown> | null>;

type HistoryRow = {
  entry_id: string;
  kind: string;
  amount: number;
  occurred_at: string;
  title: string;
  detail: string | null;
};

type RpcCall = { fn: string; args: Record<string, unknown> };

function entryUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Newest first, one minute apart, as the database orders the history. */
function historyRow(n: number, entryId: string, kind: string, amount: number): HistoryRow {
  return {
    entry_id: entryId,
    kind,
    amount,
    occurred_at: new Date(Date.UTC(2026, 10, 1) - n * 60_000).toISOString(),
    title: `${kind} ${n}`,
    detail: null,
  };
}

/**
 * Stands in for `list_credit_history`: one keyset page of `history` after the
 * cursor's entry, at most `p_limit` rows.
 */
function creditHistoryRpc(history: HistoryRow[], calls: RpcCall[] = []) {
  return (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    if (fn !== 'list_credit_history') return Promise.resolve({ data: null, error: null });
    const before = args.p_before_id as string | null;
    const start = before ? history.findIndex((row) => row.entry_id === before) + 1 : 0;
    return Promise.resolve({ data: history.slice(start, start + Number(args.p_limit)), error: null });
  };
}

/**
 * Minimal PostgREST stand-in. `filterLog` records the filters applied per table
 * so the tests can assert the `.is('mobile_product_id', null)` guard that keeps
 * a mobile purchase from appearing twice in a user's history.
 */
function createClient(
  rows: TableRows,
  filterLog: Record<string, string[]> = {},
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown> = creditHistoryRpc([]),
) {
  return {
    from(table: string) {
      filterLog[table] ??= [];
      const result = { data: rows[table] ?? [], error: null, count: 0 };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        gte: chain,
        in: chain,
        order: chain,
        is: (column: string, value: unknown) => {
          filterLog[table].push(`is:${column}=${String(value)}`);
          return builder;
        },
        limit: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve({
          data: Array.isArray(rows[table]) ? (rows[table] as unknown[])[0] ?? null : rows[table] ?? null,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      });
      return builder;
    },
    rpc,
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null } }) } },
  } as unknown as SupabaseClient;
}

const PROFILE = {
  id: USER_ID,
  username: 'creator',
  display_name: 'Creator',
  credits: 100,
  promotional_credits: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('admin user purchase history', () => {
  it('excludes the mirrored ledger row a mobile purchase writes to transactions', async () => {
    const filterLog: Record<string, string[]> = {};
    const client = createClient(
      {
        profiles: [PROFILE],
        transactions: [],
        mobile_store_transactions: [{
          id: 'mst-1',
          status: 'active',
          amount_subunits: 830000,
          currency: 'INR',
          credits: 5000,
          created_at: '2026-07-21T21:52:00.000Z',
          product_id: 'magicbooklet.credits.pro',
        }],
        credit_grants: [],
        creator_resource_wallets: null,
        generations: [],
        ai_usage_events: [],
      },
      filterLog,
    );

    const detail = await getAdminUserDetail(client, USER_ID);

    // Without the filter the same purchase is listed twice, and the ledger copy
    // is mislabelled as a web Razorpay payment.
    expect(filterLog.transactions).toContain('is:mobile_product_id=null');
    expect(detail?.purchases).toHaveLength(1);
    expect(detail?.purchases[0]).toMatchObject({ kind: 'mobile-iap', currency: 'INR' });
  });

  it('preserves each purchase currency instead of assuming INR', async () => {
    const client = createClient({
      profiles: [PROFILE],
      transactions: [],
      mobile_store_transactions: [{
        id: 'mst-usd',
        status: 'active',
        amount_subunits: 1000,
        currency: 'USD',
        credits: 100,
        created_at: '2026-07-21T00:00:00.000Z',
        product_id: 'magicbooklet.credits.starter',
      }],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
      ai_usage_events: [],
    });

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.purchases[0].currency).toBe('USD');
  });

  it('labels a web credit purchase as Razorpay INR', async () => {
    const client = createClient({
      profiles: [PROFILE],
      transactions: [{
        id: 'txn-1',
        status: 'success',
        amount: 41500,
        credits: 500,
        created_at: '2026-07-20T00:00:00.000Z',
        razorpay_payment_id: 'pay_abc123',
      }],
      mobile_store_transactions: [],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
      ai_usage_events: [],
    });

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.purchases[0]).toMatchObject({
      kind: 'razorpay',
      currency: 'INR',
      reference: 'pay_abc123',
    });
  });

  it('counts every spend in the credit history, generations included, net of refunds', async () => {
    // It used to read only ai_usage_events, the prompt enhancer's charges: an
    // account with 1,862 credits of generations showed "24 spent".
    const guestId = '7a2c9e41-0b3d-4c5e-8f6a-1b2c3d4e5f60';
    const calls: RpcCall[] = [];
    const client = createClient(
      {
        profiles: [PROFILE, { id: guestId }],
        transactions: [],
        mobile_store_transactions: [],
        credit_grants: [],
        creator_resource_wallets: null,
        generations: [],
      },
      {},
      creditHistoryRpc([
        historyRow(1, `generation:${entryUuid(1)}:refund`, 'refund', 76),
        historyRow(2, `generation:${entryUuid(1)}`, 'spend', -76),
        historyRow(3, `generation:${entryUuid(2)}`, 'spend', -140),
        historyRow(4, `ai-usage:${entryUuid(3)}`, 'spend', -4),
        historyRow(5, `purchase:${entryUuid(4)}`, 'purchase', 500),
        historyRow(6, `grant:${entryUuid(5)}`, 'grant', 25),
        historyRow(7, `admin-adjustment:${entryUuid(6)}`, 'adjustment', -10),
      ], calls),
    );

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.spend.lifetimeCreditsSpent).toBe(144);
    expect(detail?.spend.lifetimeCreditsSpentComplete).toBe(true);
    // The account and the guests linked to it, as the person's own Credit history reads it.
    const historyCalls = calls.filter((call) => call.fn === 'list_credit_history');
    expect(historyCalls[0].args.p_user_ids).toEqual([USER_ID, guestId]);
  });

  it('stops at a bounded number of history pages and says the figure is a lower bound', async () => {
    const history = Array.from({ length: 1_050 }, (_, index) => (
      historyRow(index + 1, `generation:${entryUuid(index + 1)}`, 'spend', -1)
    ));
    const client = createClient(
      {
        profiles: [PROFILE],
        transactions: [],
        mobile_store_transactions: [],
        credit_grants: [],
        creator_resource_wallets: null,
        generations: [],
      },
      {},
      creditHistoryRpc(history),
    );

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.spend.lifetimeCreditsSpent).toBe(1_000);
    expect(detail?.spend.lifetimeCreditsSpentComplete).toBe(false);
  });

  it('fails the page rather than show a spend figure it could not read', async () => {
    const client = createClient(
      {
        profiles: [PROFILE],
        transactions: [],
        mobile_store_transactions: [],
        credit_grants: [],
        creator_resource_wallets: null,
        generations: [],
      },
      {},
      (fn: string) => Promise.resolve(
        fn === 'list_credit_history'
          ? { data: null, error: { message: 'statement timeout' } }
          : { data: null, error: null },
      ),
    );

    await expect(getAdminUserDetail(client, USER_ID)).rejects.toThrow(/list_credit_history/);
  });

  it('says a guest is a guest, and which account a linked guest belongs to', async () => {
    const accountId = '5b0e8a1c-2d3f-4a5b-8c6d-7e8f9a0b1c2d';
    const base = createClient({
      profiles: [{ ...PROFILE, display_name: null, merged_into_user_id: accountId }],
      transactions: [],
      mobile_store_transactions: [],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
    });
    const client = {
      ...base,
      from: base.from.bind(base),
      rpc: base.rpc.bind(base),
      auth: { admin: { getUserById: () => Promise.resolve({ data: { user: { id: USER_ID, is_anonymous: true } } }) } },
    } as unknown as SupabaseClient;

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.accountKind).toBe('guest');
    expect(detail?.linkedToUserId).toBe(accountId);
  });

  it('calls an identity with a sign-in a registered account', async () => {
    const client = createClient({
      profiles: [PROFILE],
      transactions: [],
      mobile_store_transactions: [],
      credit_grants: [],
      creator_resource_wallets: null,
      generations: [],
    });

    const detail = await getAdminUserDetail(client, USER_ID);

    expect(detail?.accountKind).toBe('registered');
    expect(detail?.linkedToUserId).toBeNull();
  });

  it('rejects a non-UUID user id rather than issuing a broad query', async () => {
    const client = createClient({ profiles: [PROFILE] });
    await expect(getAdminUserDetail(client, 'not-a-uuid')).rejects.toThrow(/UUID/);
  });
});

function searchRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    username: `creator-${id.slice(0, 8)}`,
    display_name: null,
    avatar_url: null,
    credits: 0,
    promotional_credits: 0,
    created_at: '2026-11-01T00:00:00.000Z',
    is_guest: false,
    merged_into_user_id: null,
    total_count: 1,
    ...overrides,
  };
}

describe('admin user search', () => {
  it('lists registered accounts by default, not every guest identity', async () => {
    // 540 of production's 620 profiles were guests, listed as "Unnamed" people.
    const calls: RpcCall[] = [];
    const client = createClient({}, {}, (fn, args = {}) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: [searchRow(USER_ID, { total_count: 80 })], error: null });
    });

    const result = await searchAdminUsers(client, { limit: 50 });

    expect(calls).toEqual([{
      fn: 'admin_search_users',
      args: { p_term: null, p_kind: 'registered', p_limit: 50, p_offset: 0 },
    }]);
    expect(result.total).toBe(80);
    expect(result.kind).toBe('registered');
  });

  it('searches every kind when a term is given, so a guest id from a report is found', async () => {
    const calls: RpcCall[] = [];
    const client = createClient({}, {}, (fn, args = {}) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: [], error: null });
    });

    const result = await searchAdminUsers(client, { term: '  fluffy  ' });

    expect(calls[0].args).toMatchObject({ p_term: 'fluffy', p_kind: 'all' });
    expect(result.kind).toBe('all');
  });

  it('keeps an explicit kind over the term default', async () => {
    const calls: RpcCall[] = [];
    const client = createClient({}, {}, (fn, args = {}) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: [], error: null });
    });

    await searchAdminUsers(client, { term: 'fluffy', kind: 'guests' });

    expect(calls[0].args).toMatchObject({ p_term: 'fluffy', p_kind: 'guests' });
  });

  it('says which rows are guests and which account a linked guest belongs to', async () => {
    const linkedTo = '5b0e8a1c-2d3f-4a5b-8c6d-7e8f9a0b1c2d';
    const client = createClient({}, {}, () => Promise.resolve({
      data: [
        searchRow(USER_ID, { display_name: 'Creator', total_count: 3 }),
        searchRow('6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', { is_guest: true, total_count: 3 }),
        searchRow('7d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a', { is_guest: true, merged_into_user_id: linkedTo, total_count: 3 }),
      ],
      error: null,
    }));

    const result = await searchAdminUsers(client, { kind: 'all' });

    expect(result.users.map((user) => [user.isGuest, user.linkedToUserId])).toEqual([
      [false, null],
      [true, null],
      [true, linkedTo],
    ]);
  });

  it('shows the first page when the requested one is past the end', async () => {
    const calls: RpcCall[] = [];
    const client = createClient({}, {}, (fn, args = {}) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: args.p_offset === 0 ? [searchRow(USER_ID, { total_count: 1 })] : [], error: null });
    });

    const result = await searchAdminUsers(client, { offset: 500 });

    expect(calls.map((call) => call.args.p_offset)).toEqual([500, 0]);
    expect(result.offset).toBe(0);
    expect(result.total).toBe(1);
    expect(result.users).toHaveLength(1);
  });

  it('fails rather than show an empty list it could not read', async () => {
    const client = createClient({}, {}, () => Promise.resolve({ data: null, error: { message: 'Isolated search outage' } }));

    await expect(searchAdminUsers(client)).rejects.toMatchObject({ message: 'Isolated search outage' });
  });
});
