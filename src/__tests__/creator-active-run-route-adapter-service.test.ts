import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityResult } from '@/lib/account-identity';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  CREATOR_ACTIVE_RUN_READ_RATE_LIMIT,
  getCreatorActiveRunRouteResponse,
} from '@/lib/creator-active-run-route-adapter-service';
import type { CreatorActiveRun } from '@/lib/creator-active-run-service';

const RUN: CreatorActiveRun = {
  id: 'gen-1',
  predictionId: 'pred-1',
  status: 'processing',
  createdAt: '2026-10-31T09:10:02.087Z',
  prompt: 'A lighthouse at dawn',
  cost: 8,
  model: 'nano-banana-2',
  duration: null,
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
  findCreatorActiveRun = vi.fn(async () => RUN),
  enforceBackendRateLimit = vi.fn(async () => ({
    allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-31T10:00:00.000Z',
  })),
}: {
  caller?: IdentityResult;
  linkedIds?: string[];
  findCreatorActiveRun?: ReturnType<typeof vi.fn>;
  enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
} = {}) {
  const admin = { from: vi.fn() } as unknown as SupabaseClient;
  // The caller's own client may not read these columns: it must never be asked to.
  const userClient = {
    from: vi.fn(() => { throw new Error('the user client read a table'); }),
  } as unknown as SupabaseClient;
  const dependencies = {
    createServiceClient: vi.fn(() => admin),
    createUserClient: vi.fn(() => userClient),
    enforceBackendRateLimit,
    findCreatorActiveRun,
    logError: vi.fn(),
    requireIdentity: vi.fn(async () => caller),
    resolveLinkedAccountIds: vi.fn(async () => linkedIds),
  };
  const answer = (query = 'tool=image', headers: Record<string, string> = {}) => getCreatorActiveRunRouteResponse({
    request: new Request(`http://localhost/api/generations/active${query ? `?${query}` : ''}`, { headers }),
    dependencies: dependencies as never,
  });
  return { admin, userClient, dependencies, answer };
}

describe('GET /api/generations/active', () => {
  it('reads an account\'s run together with the guests linked to it, on the service client', async () => {
    const { admin, userClient, dependencies, answer } = setup();

    const response = await answer('tool=image', { 'x-request-id': 'active-run-1' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('active-run-1');
    await expect(response.json()).resolves.toEqual({ run: RUN });
    expect(dependencies.requireIdentity).toHaveBeenCalledWith(userClient, expect.any(Function));
    expect(dependencies.resolveLinkedAccountIds).toHaveBeenCalledWith(admin, 'account-1');
    expect(dependencies.findCreatorActiveRun).toHaveBeenCalledWith({
      client: admin,
      userIds: ['account-1', 'guest-1'],
      tool: 'image',
    });
    expect(dependencies.enforceBackendRateLimit).toHaveBeenCalledWith(admin, {
      ...CREATOR_ACTIVE_RUN_READ_RATE_LIMIT,
      key: 'account-1',
    });
    expect(userClient.from).not.toHaveBeenCalled();
    // One privileged client for the limiter, the link lookup and the read.
    expect(dependencies.createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('reads a guest\'s own run without a link lookup', async () => {
    const { admin, dependencies, answer } = setup({ caller: identity('guest-7', true) });

    const response = await answer('tool=motion');

    expect(response.status).toBe(200);
    expect(dependencies.resolveLinkedAccountIds).not.toHaveBeenCalled();
    expect(dependencies.findCreatorActiveRun).toHaveBeenCalledWith({ client: admin, userIds: ['guest-7'], tool: 'motion' });
  });

  it('answers null when no run of the tool is at work', async () => {
    const { answer } = setup({ findCreatorActiveRun: vi.fn(async () => null) });

    const response = await answer('tool=video');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: null });
  });

  it.each(['', 'tool=', 'tool=audio', 'tool=IMAGE'])('answers a tool it does not know 400 (%j) before any read', async (query) => {
    const { dependencies, answer } = setup();

    const response = await answer(query);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'tool must be image, video or motion.',
      code: 'INVALID_TOOL',
    });
    expect(dependencies.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(dependencies.findCreatorActiveRun).not.toHaveBeenCalled();
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
    expect(dependencies.findCreatorActiveRun).not.toHaveBeenCalled();
  });

  it('answers a caller over the read budget 429', async () => {
    const { dependencies, answer } = setup({
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false, limit: 120, remaining: 0, retryAfterSeconds: 42, resetAt: '2026-10-31T10:00:00.000Z',
        });
      }),
    });

    const response = await answer();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(dependencies.findCreatorActiveRun).not.toHaveBeenCalled();
  });

  it('answers a failed read 500 and logs it', async () => {
    const failure = Object.assign(new Error('permission denied for table generations'), { code: '42501' });
    const { dependencies, answer } = setup({ findCreatorActiveRun: vi.fn(async () => { throw failure; }) });

    const response = await answer();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Could not check for a run in progress.' });
    expect(dependencies.logError).toHaveBeenCalledWith('Failed to load the creator active run:', failure);
  });

  it('answers a broken rate-limit check 500 without reading', async () => {
    const { dependencies, answer } = setup({
      enforceBackendRateLimit: vi.fn(async () => { throw new Error('rate limit table missing'); }),
    });

    const response = await answer();

    expect(response.status).toBe(500);
    expect(dependencies.findCreatorActiveRun).not.toHaveBeenCalled();
    expect(dependencies.logError).toHaveBeenCalledWith('Creator active run rate limit check failed:', expect.any(Error));
  });

  it('is served by a thin route file', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/generations/active/route.ts'), 'utf8');

    expect(route).toContain("from '@/lib/creator-active-run-route-adapter-service'");
    expect(route).toContain('export const { GET } = createCreatorActiveRunRouteHandlers();');
  });
});
