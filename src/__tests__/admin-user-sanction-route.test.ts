import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateAdminRequestMock = vi.hoisted(() => vi.fn());
const applyAdminUserSanctionMock = vi.hoisted(() => vi.fn());
const enforceBackendRateLimitMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/admin-auth', () => ({
  authenticateAdminRequest: (request: Request) => authenticateAdminRequestMock(request),
}));

vi.mock('@/lib/admin-user-sanction-service', () => ({
  applyAdminUserSanction: (...args: unknown[]) => applyAdminUserSanctionMock(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: 'admin' }),
}));

vi.mock('@/lib/backend-rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backend-rate-limit')>();
  return {
    ...actual,
    enforceBackendRateLimit: (...args: unknown[]) => enforceBackendRateLimitMock(...args),
  };
});

import { postAdminUserSanction } from '@/lib/admin-user-sanction-route-adapter-service';

const SESSION_REVIEWER = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET_USER = 'bbbbbbbb-0000-4000-8000-000000000002';

function request(body: unknown) {
  return new Request('https://example.com/api/admin/users/sanctions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authenticated() {
  authenticateAdminRequestMock.mockResolvedValue({
    authenticated: true,
    identity: { subject: 'admin', username: 'admin', reviewerUserId: SESSION_REVIEWER },
  });
}

describe('admin user sanction route', () => {
  beforeEach(() => {
    authenticateAdminRequestMock.mockReset();
    applyAdminUserSanctionMock.mockReset();
    enforceBackendRateLimitMock.mockClear();
  });

  it('rejects an unauthenticated caller before touching the service', async () => {
    authenticateAdminRequestMock.mockResolvedValue({ authenticated: false, reason: 'unauthenticated' });

    const response = await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend' }));

    expect(response.status).toBe(401);
    expect(applyAdminUserSanctionMock).not.toHaveBeenCalled();
  });

  it('reports an unconfigured console as 503 rather than a login failure', async () => {
    authenticateAdminRequestMock.mockResolvedValue({ authenticated: false, reason: 'unconfigured' });

    const response = await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend' }));

    expect(response.status).toBe(503);
  });

  /**
   * The security-critical assertion. If a caller could name the reviewer, the
   * audit trail would attribute a suspension to whoever they chose.
   */
  it('takes the reviewer from the session and ignores one supplied in the body', async () => {
    authenticated();
    applyAdminUserSanctionMock.mockResolvedValue({ status: 'applied', sanctionId: 's1', action: 'suspend', suspendedUntil: null, error: null });

    await postAdminUserSanction(request({
      userId: TARGET_USER,
      action: 'suspend',
      reason: 'Spam ring.',
      durationHours: 24,
      reviewerId: 'cccccccc-0000-4000-8000-000000000003',
    }));

    expect(applyAdminUserSanctionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reviewerId: SESSION_REVIEWER }),
    );
  });

  it('preserves an indefinite suspension instead of coercing null to zero hours', async () => {
    authenticated();
    applyAdminUserSanctionMock.mockResolvedValue({ status: 'applied', sanctionId: 's1', action: 'suspend', suspendedUntil: null, error: null });

    await postAdminUserSanction(request({
      userId: TARGET_USER, action: 'suspend', reason: 'Spam ring.', durationHours: null,
    }));

    expect(applyAdminUserSanctionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ durationHours: null }),
    );
  });

  it('rejects an unknown action', async () => {
    authenticated();

    const response = await postAdminUserSanction(request({
      userId: TARGET_USER, action: 'delete_account', reason: 'nope',
    }));

    expect(response.status).toBe(400);
    expect(applyAdminUserSanctionMock).not.toHaveBeenCalled();
  });

  it('maps a rejected sanction to 400 and a missing user to 404', async () => {
    authenticated();

    applyAdminUserSanctionMock.mockResolvedValue({ status: 'invalid', error: 'reason is required', sanctionId: null, action: null, suspendedUntil: null });
    const invalid = await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend', reason: '' }));
    expect(invalid.status).toBe(400);

    applyAdminUserSanctionMock.mockResolvedValue({ status: 'not_found', error: null, sanctionId: null, action: null, suspendedUntil: null });
    const missing = await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend', reason: 'Spam.' }));
    expect(missing.status).toBe(404);
  });

  it('rate limits per operator so a scripted loop cannot mass-suspend', async () => {
    authenticated();
    applyAdminUserSanctionMock.mockResolvedValue({ status: 'applied', sanctionId: 's1', action: 'suspend', suspendedUntil: null, error: null });

    await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend', reason: 'Spam.' }));

    expect(enforceBackendRateLimitMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'admin-user-sanction', key: SESSION_REVIEWER }),
    );
  });

  it('never caches a sanction response', async () => {
    authenticated();
    applyAdminUserSanctionMock.mockResolvedValue({ status: 'applied', sanctionId: 's1', action: 'suspend', suspendedUntil: null, error: null });

    const response = await postAdminUserSanction(request({ userId: TARGET_USER, action: 'suspend', reason: 'Spam.' }));

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
