import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  CREDIT_HISTORY_DEFAULT_LIMIT,
  CREDIT_HISTORY_MAX_LIMIT,
  decodeCreditHistoryCursor,
  encodeCreditHistoryCursor,
  listCreditHistory,
  parseCreditHistoryLimit,
  parseCreditHistoryQuery,
} from '@/lib/credit-history-service';

const VIDEO_CHARGE = 'generation:5f0c2d7e-8a41-4b6c-9d2e-1f3a4b5c6d7e:charge';
const PURCHASE = 'purchase:0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

function row(entryId: string, occurredAt: string, overrides: Record<string, unknown> = {}) {
  return {
    entry_id: entryId,
    kind: 'spend',
    amount: -120,
    occurred_at: occurredAt,
    title: 'Video generation',
    detail: null,
    ...overrides,
  };
}

function clientReturning(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>>(
    async () => ({ data, error }),
  );
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

describe('credit history cursor', () => {
  it('carries the database timestamp text whole, microseconds included', () => {
    const cursor = { occurredAt: '2026-10-15T09:10:02.087654+00:00', id: VIDEO_CHARGE };
    const encoded = encodeCreditHistoryCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCreditHistoryCursor(encoded)).toEqual(cursor);
  });

  it.each([
    ['an empty string', ''],
    ['text that is not base64url', 'not a cursor!'],
    ['base64url that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['a JSON array', Buffer.from('[1,2]', 'utf8').toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 2, t: '2026-10-15T09:10:02+00:00', i: VIDEO_CHARGE })).toString('base64url')],
    ['a time that is not a timestamp', Buffer.from(JSON.stringify({ v: 1, t: 'yesterday', i: VIDEO_CHARGE })).toString('base64url')],
    ['an impossible date', Buffer.from(JSON.stringify({ v: 1, t: '2026-13-45T09:10:02+00:00', i: VIDEO_CHARGE })).toString('base64url')],
    // Date.parse rolls this over to March 2; Postgres would refuse it with a 500.
    ['a day the month does not have', Buffer.from(JSON.stringify({ v: 1, t: '2026-02-30T09:10:02+00:00', i: VIDEO_CHARGE })).toString('base64url')],
    ['an hour past midnight', Buffer.from(JSON.stringify({ v: 1, t: '2026-10-15T24:10:02+00:00', i: VIDEO_CHARGE })).toString('base64url')],
    ['a timestamp without its zone', Buffer.from(JSON.stringify({ v: 1, t: '2026-10-15T09:10:02', i: VIDEO_CHARGE })).toString('base64url')],
    ['an id the list never writes', Buffer.from(JSON.stringify({ v: 1, t: '2026-10-15T09:10:02+00:00', i: "x' or 1=1" })).toString('base64url')],
    ['a missing id', Buffer.from(JSON.stringify({ v: 1, t: '2026-10-15T09:10:02+00:00' })).toString('base64url')],
    ['an overlong value', 'a'.repeat(257)],
  ])('refuses %s', (_label, value) => {
    expect(decodeCreditHistoryCursor(value)).toBeNull();
  });
});

describe('credit history query', () => {
  it.each([
    [null, CREDIT_HISTORY_DEFAULT_LIMIT],
    ['', CREDIT_HISTORY_DEFAULT_LIMIT],
    ['  ', CREDIT_HISTORY_DEFAULT_LIMIT],
    ['1', 1],
    ['30', 30],
    ['50', CREDIT_HISTORY_MAX_LIMIT],
    ['0', 1],
    ['51', CREDIT_HISTORY_MAX_LIMIT],
    ['99999999999999999999999', CREDIT_HISTORY_MAX_LIMIT],
    [' 12 ', 12],
  ])('holds limit %j to %d', (value, expected) => {
    expect(parseCreditHistoryLimit(value)).toBe(expected);
  });

  it.each(['-1', '1.5', 'ten', '10abc', '1e3', '0x10'])('refuses limit %j', (value) => {
    expect(parseCreditHistoryLimit(value)).toBeNull();
  });

  it('reads the first page without a cursor', () => {
    expect(parseCreditHistoryQuery(new URLSearchParams(''))).toEqual({
      ok: true,
      query: { cursor: null, limit: CREDIT_HISTORY_DEFAULT_LIMIT },
    });
    expect(parseCreditHistoryQuery(new URLSearchParams('cursor=&limit=5'))).toEqual({
      ok: true,
      query: { cursor: null, limit: 5 },
    });
  });

  it('reads a later page from the cursor it wrote', () => {
    const cursor = { occurredAt: '2026-10-15T09:10:02.087654+00:00', id: VIDEO_CHARGE };

    expect(parseCreditHistoryQuery(new URLSearchParams({ cursor: encodeCreditHistoryCursor(cursor), limit: '10' })))
      .toEqual({ ok: true, query: { cursor, limit: 10 } });
  });

  it('answers a malformed cursor or limit with its own code', () => {
    expect(parseCreditHistoryQuery(new URLSearchParams('cursor=abc'))).toMatchObject({ ok: false, code: 'INVALID_CURSOR' });
    expect(parseCreditHistoryQuery(new URLSearchParams('limit=many'))).toMatchObject({ ok: false, code: 'INVALID_LIMIT' });
  });
});

describe('listCreditHistory', () => {
  it('asks for one more row than the page and pages from the last row it returns', async () => {
    const rows = [
      row(VIDEO_CHARGE, '2026-10-15T09:10:02.087654+00:00'),
      row(PURCHASE, '2026-10-12T11:05:44.02+00:00', { kind: 'purchase', amount: 2000, title: 'Creator pack', detail: 'Bought in the app' }),
      row('grant:6c1b2a90-4d3e-4f5a-9b8c-7d6e5f4a3b2c', '2026-10-10T08:00:00+00:00', { kind: 'grant', amount: 25, title: 'Welcome credits' }),
    ];
    const { rpc, client } = clientReturning(rows);

    const page = await listCreditHistory({ client, userIds: ['account-1', 'guest-1'], cursor: null, limit: 2 });

    expect(rpc).toHaveBeenCalledWith('list_credit_history', {
      p_user_ids: ['account-1', 'guest-1'],
      p_before_occurred_at: null,
      p_before_id: null,
      p_limit: 3,
    });
    expect(page.entries).toEqual([
      {
        id: VIDEO_CHARGE,
        kind: 'spend',
        amount: -120,
        occurredAt: '2026-10-15T09:10:02.087Z',
        title: 'Video generation',
        detail: null,
      },
      {
        id: PURCHASE,
        kind: 'purchase',
        amount: 2000,
        occurredAt: '2026-10-12T11:05:44.020Z',
        title: 'Creator pack',
        detail: 'Bought in the app',
      },
    ]);
    expect(decodeCreditHistoryCursor(page.nextCursor ?? '')).toEqual({
      occurredAt: '2026-10-12T11:05:44.02+00:00',
      id: PURCHASE,
    });
  });

  it('sends the cursor back as the keyset and ends the list when no extra row comes back', async () => {
    const cursor = { occurredAt: '2026-10-12T11:05:44.020001+00:00', id: PURCHASE };
    const { rpc, client } = clientReturning([row(VIDEO_CHARGE, '2026-10-01T09:10:02+00:00')]);

    const page = await listCreditHistory({ client, userIds: ['guest-1'], cursor, limit: 30 });

    expect(rpc).toHaveBeenCalledWith('list_credit_history', {
      p_user_ids: ['guest-1'],
      p_before_occurred_at: '2026-10-12T11:05:44.020001+00:00',
      p_before_id: PURCHASE,
      p_limit: 31,
    });
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('answers an empty history as an empty last page', async () => {
    const { client } = clientReturning([]);

    await expect(listCreditHistory({ client, userIds: ['guest-1'], cursor: null, limit: 30 }))
      .resolves.toEqual({ entries: [], nextCursor: null });
  });

  it('holds a page to 1–50 rows whatever it is handed', async () => {
    const { rpc, client } = clientReturning([]);

    await listCreditHistory({ client, userIds: ['account-1'], cursor: null, limit: 500 });
    await listCreditHistory({ client, userIds: ['account-1'], cursor: null, limit: 0 });

    expect(rpc.mock.calls.map(([, args]) => args.p_limit)).toEqual([51, 2]);
  });

  it('reads a blank detail as none', async () => {
    const { client } = clientReturning([row(VIDEO_CHARGE, '2026-10-15T09:10:02+00:00', { detail: '  ' })]);

    const page = await listCreditHistory({ client, userIds: ['account-1'], cursor: null, limit: 30 });

    expect(page.entries[0].detail).toBeNull();
  });

  it('fails the page on a database error, with its words', async () => {
    const { client } = clientReturning(null, { message: 'list_credit_history reads one identity and the guests linked to it' });

    await expect(listCreditHistory({ client, userIds: ['account-1', 'stranger-1'], cursor: null, limit: 30 }))
      .rejects.toThrow('list_credit_history failed: list_credit_history reads one identity and the guests linked to it');
  });

  it.each([
    ['an unknown kind', { kind: 'merge' }, '(kind; source generation)'],
    ['a fractional amount', { amount: 1.5 }, '(amount; source generation)'],
    ['a missing amount', { amount: null }, '(amount; source generation)'],
    ['an unreadable time', { occurred_at: 'soon' }, '(occurred_at; source generation)'],
    ['an empty title', { title: ' ' }, '(title; source generation)'],
    ['an id the list never writes', { entry_id: 'merge:1' }, '(entry_id; source merge)'],
    ['a detail that is not text', { detail: 42 }, '(detail; source generation)'],
  ])('fails the page rather than drop a row with %s, naming the field and source', async (_label, overrides, named) => {
    const { client } = clientReturning([row(VIDEO_CHARGE, '2026-10-15T09:10:02+00:00', overrides)]);

    await expect(listCreditHistory({ client, userIds: ['account-1'], cursor: null, limit: 30 }))
      .rejects.toThrow(`list_credit_history returned a row outside its contract ${named}`);
  });

  it('fails the page when the database answers something other than rows', async () => {
    const { client } = clientReturning({ entries: [] });

    await expect(listCreditHistory({ client, userIds: ['account-1'], cursor: null, limit: 30 }))
      .rejects.toThrow('list_credit_history returned no rows array');
  });
});

describe('listCreditHistory with more linked guests than one database call takes', () => {
  // Production, 2026-11-04: an account with 156 linked guest identities (157 ids)
  // got a 500, because list_credit_history refuses more than 100 ids.
  const ACCOUNT = 'account-1';
  const GUESTS = Array.from({ length: 156 }, (_, index) => `guest-${index + 1}`);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  type OwnedRow = ReturnType<typeof row> & { owner: string };

  /** Answers as the SQL does: the cap, the identity-set check, the keyset and the order. */
  function databaseHolding(owned: OwnedRow[]) {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const ids = args.p_user_ids as string[];
      if (ids.length < 1 || ids.length > 100) {
        return { data: null, error: { message: 'list_credit_history needs 1 to 100 identity ids' } };
      }
      if (ids[0] !== ACCOUNT || ids.slice(1).some((id) => !GUESTS.includes(id))) {
        return { data: null, error: { message: 'list_credit_history reads one identity and the guests linked to it' } };
      }
      const beforeAt = args.p_before_occurred_at as string | null;
      const beforeId = args.p_before_id as string | null;
      const data = owned
        .filter((entry) => ids.includes(entry.owner))
        .filter((entry) => !beforeAt
          || Date.parse(entry.occurred_at) < Date.parse(beforeAt)
          || (Date.parse(entry.occurred_at) === Date.parse(beforeAt) && entry.entry_id < (beforeId as string)))
        .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
          || (a.entry_id < b.entry_id ? 1 : -1))
        .slice(0, args.p_limit as number)
        .map((entry) => row(entry.entry_id, entry.occurred_at, {
          kind: entry.kind,
          amount: entry.amount,
          title: entry.title,
          detail: entry.detail,
        }));
      return { data, error: null };
    });
    return { rpc, client: { rpc } as unknown as SupabaseClient };
  }

  const owned: OwnedRow[] = [
    { ...row(`purchase:${uuid(1)}`, '2026-11-01T10:00:00+00:00', { kind: 'purchase', amount: 2000, title: 'Creator pack' }), owner: ACCOUNT },
    { ...row(`generation:${uuid(2)}:charge`, '2026-10-30T10:00:00.5+00:00'), owner: 'guest-150' },
    { ...row(`generation:${uuid(3)}:charge`, '2026-10-30T10:00:00.25+00:00'), owner: 'guest-3' },
    { ...row(`grant:${uuid(4)}`, '2026-10-29T10:00:00+00:00', { kind: 'grant', amount: 100, title: 'Welcome credits' }), owner: 'guest-120' },
    { ...row(`generation:${uuid(5)}:charge`, '2026-10-28T10:00:00+00:00'), owner: ACCOUNT },
  ];

  it('reads the whole set in calls the database takes and merges them newest first', async () => {
    const { rpc, client } = databaseHolding(owned);

    const first = await listCreditHistory({ client, userIds: [ACCOUNT, ...GUESTS], cursor: null, limit: 3 });

    for (const [, args] of rpc.mock.calls) {
      const ids = args.p_user_ids as string[];
      expect(ids.length).toBeLessThanOrEqual(100);
      expect(ids[0]).toBe(ACCOUNT);
    }
    expect(new Set(rpc.mock.calls.flatMap(([, args]) => args.p_user_ids as string[]))).toEqual(new Set([ACCOUNT, ...GUESTS]));
    expect(first.entries.map((entry) => entry.id)).toEqual([
      `purchase:${uuid(1)}`,
      `generation:${uuid(2)}:charge`,
      `generation:${uuid(3)}:charge`,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listCreditHistory({
      client,
      userIds: [ACCOUNT, ...GUESTS],
      cursor: decodeCreditHistoryCursor(first.nextCursor as string),
      limit: 3,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual([`grant:${uuid(4)}`, `generation:${uuid(5)}:charge`]);
    expect(second.nextCursor).toBeNull();
  });

  it('lists the account\'s own rows once, though every call reads them', async () => {
    const { client } = databaseHolding(owned);

    const page = await listCreditHistory({ client, userIds: [ACCOUNT, ...GUESTS], cursor: null, limit: 30 });

    expect(page.entries.map((entry) => entry.id)).toEqual(owned.map((entry) => entry.entry_id));
  });

  it('still makes one call for a set the database takes whole', async () => {
    const { rpc, client } = databaseHolding(owned);

    await listCreditHistory({ client, userIds: [ACCOUNT, ...GUESTS.slice(0, 99)], cursor: null, limit: 30 });

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
