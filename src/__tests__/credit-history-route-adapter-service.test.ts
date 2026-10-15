import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityResult } from '@/lib/account-identity';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  CREDIT_HISTORY_READ_RATE_LIMIT,
  getCreditHistoryRouteResponse,
} from '@/lib/credit-history-route-adapter-service';
import { encodeCreditHistoryCursor, type CreditHistoryPage } from '@/lib/credit-history-service';

const PAGE: CreditHistoryPage = {
  entries: [
    {
      id: 'generation:5f0c2d7e-8a41-4b6c-9d2e-1f3a4b5c6d7e:charge',
      kind: 'spend',
      amount: -120,
      occurredAt: '2026-10-15T09:10:02.087Z',
      title: 'Video generation',
      detail: null,
    },
  ],
  nextCursor: null,
};

function identity(userId: string, isGuest: boolean): IdentityResult {
  return {
    ok: true,
    identity: {
      user: { id: userId, is_anonymous: isGuest } as User,
      userId,
      kind: isGuest ? 'guest' : 'registered',
      isGuest,
    },
  };
}

function setup({
  caller = identity('account-1', false),
  linkedIds = ['account-1', 'guest-1'],
  listCreditHistory = vi.fn(async () => PAGE),
  enforceBackendRateLimit = vi.fn(async () => ({
    allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-15T10:00:00.000Z',
  })),
}: {
  caller?: IdentityResult;
  linkedIds?: string[];
  listCreditHistory?: ReturnType<typeof vi.fn>;
  enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
} = {}) {
  const admin = { rpc: vi.fn() } as unknown as SupabaseClient;
  const userClient = {} as unknown as SupabaseClient;
  const dependencies = {
    createServiceClient: vi.fn(() => admin),
    createUserClient: vi.fn(() => userClient),
    enforceBackendRateLimit,
    listCreditHistory,
    logError: vi.fn(),
    requireIdentity: vi.fn(async () => caller),
    resolveLinkedAccountIds: vi.fn(async () => linkedIds),
  };
  const answer = (query = '', headers: Record<string, string> = {}) => getCreditHistoryRouteResponse({
    request: new Request(`http://localhost/api/credits/history${query ? `?${query}` : ''}`, { headers }),
    dependencies: dependencies as never,
  });
  return { admin, userClient, dependencies, answer };
}

describe('GET /api/credits/history', () => {
  it('reads a registered account together with the guests linked to it', async () => {
    const { admin, userClient, dependencies, answer } = setup();

    const response = await answer('', { 'x-request-id': 'credit-history-1' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-history-1');
    await expect(response.json()).resolves.toEqual(PAGE);
    expect(dependencies.requireIdentity).toHaveBeenCalledWith(userClient, expect.any(Function));
    expect(dependencies.resolveLinkedAccountIds).toHaveBeenCalledWith(admin, 'account-1');
    expect(dependencies.listCreditHistory).toHaveBeenCalledWith({
      client: admin,
      userIds: ['account-1', 'guest-1'],
      cursor: null,
      limit: 30,
    });
    expect(dependencies.enforceBackendRateLimit).toHaveBeenCalledWith(admin, {
      ...CREDIT_HISTORY_READ_RATE_LIMIT,
      key: 'account-1',
    });
    // One privileged client for the limiter, the link lookup and the read.
    expect(dependencies.createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('reads a guest\'s own history without a link lookup', async () => {
    const { admin, dependencies, answer } = setup({ caller: identity('guest-7', true) });

    const response = await answer('limit=10');

    expect(response.status).toBe(200);
    expect(dependencies.resolveLinkedAccountIds).not.toHaveBeenCalled();
    expect(dependencies.listCreditHistory).toHaveBeenCalledWith({
      client: admin,
      userIds: ['guest-7'],
      cursor: null,
      limit: 10,
    });
  });

  it('passes the next page\'s cursor through as its keyset', async () => {
    const cursor = { occurredAt: '2026-10-12T11:05:44.020001+00:00', id: 'purchase:0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d' };
    const { dependencies, answer } = setup();

    const response = await answer(`cursor=${encodeCreditHistoryCursor(cursor)}&limit=20`);

    expect(response.status).toBe(200);
    expect(dependencies.listCreditHistory).toHaveBeenCalledWith(expect.objectContaining({ cursor, limit: 20 }));
  });

  it.each([
    ['', 30],
    ['limit=1', 1],
    ['limit=50', 50],
    ['limit=0', 1],
    ['limit=51', 50],
    ['limit=1000', 50],
  ])('holds %j to a page of %d', async (query, limit) => {
    const { dependencies, answer } = setup();

    const response = await answer(query);

    expect(response.status).toBe(200);
    expect(dependencies.listCreditHistory).toHaveBeenCalledWith(expect.objectContaining({ limit }));
  });

  it.each(['cursor=abc', 'cursor=%7B%7D', `cursor=${'A'.repeat(300)}`])('answers a malformed cursor 400 (%s) before any read', async (query) => {
    const { dependencies, answer } = setup();

    const response = await answer(query);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'This page of your credit history is no longer available. Reload it from the start.',
      code: 'INVALID_CURSOR',
    });
    expect(dependencies.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(dependencies.listCreditHistory).not.toHaveBeenCalled();
  });

  it.each(['limit=-5', 'limit=2.5', 'limit=all'])('answers a limit that is not a whole number 400 (%s)', async (query) => {
    const { dependencies, answer } = setup();

    const response = await answer(query);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'limit must be a whole number from 1 to 50.',
      code: 'INVALID_LIMIT',
    });
    expect(dependencies.listCreditHistory).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'UNAUTHORIZED', 'Unauthorized'],
    [409, 'SESSION_MERGED', 'This guest session has been linked to an account. Sign in to continue.'],
    [409, 'ACCOUNT_DELETING', 'This account is being permanently deleted.'],
    [503, 'IDENTITY_CHECK_UNAVAILABLE', 'Identity verification is temporarily unavailable. Please try again.'],
  ] as const)('answers an identity refusal %d %s before any read', async (status, code, error) => {
    const { dependencies, answer } = setup({ caller: { ok: false, status, code, error } });

    const response = await answer();

    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(dependencies.createServiceClient).not.toHaveBeenCalled();
    expect(dependencies.listCreditHistory).not.toHaveBeenCalled();
  });

  it('answers a caller over the read budget 429', async () => {
    const { dependencies, answer } = setup({
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false, limit: 120, remaining: 0, retryAfterSeconds: 42, resetAt: '2026-10-15T10:00:00.000Z',
        });
      }),
    });

    const response = await answer();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(dependencies.listCreditHistory).not.toHaveBeenCalled();
  });

  it('answers a failed read 500 and logs it', async () => {
    const failure = new Error('list_credit_history failed: database tired');
    const { dependencies, answer } = setup({ listCreditHistory: vi.fn(async () => { throw failure; }) });

    const response = await answer();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Could not load your credit history. Please try again.' });
    expect(dependencies.logError).toHaveBeenCalledWith('Failed to load credit history:', failure);
  });

  it('answers a broken rate-limit check 500 without reading', async () => {
    const { dependencies, answer } = setup({
      enforceBackendRateLimit: vi.fn(async () => { throw new Error('rate limit table missing'); }),
    });

    const response = await answer();

    expect(response.status).toBe(500);
    expect(dependencies.listCreditHistory).not.toHaveBeenCalled();
    expect(dependencies.logError).toHaveBeenCalledWith('Credit history rate limit check failed:', expect.any(Error));
  });

  it('is served by a thin route file', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/credits/history/route.ts'), 'utf8');

    expect(route).toContain("from '@/lib/credit-history-route-adapter-service'");
    expect(route).toContain('export const { GET } = createCreditHistoryRouteHandlers();');
  });
});
