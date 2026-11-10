import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateAdminRequestMock = vi.hoisted(() => vi.fn());
const applyReferralReviewActionMock = vi.hoisted(() => vi.fn());
const logBackendRouteErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/admin-auth', () => ({
  authenticateAdminRequest: (request: Request) => authenticateAdminRequestMock(request),
}));

vi.mock('@/lib/admin-referrals-service', () => ({
  applyReferralReviewAction: (...args: unknown[]) => applyReferralReviewActionMock(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: 'admin' }),
}));

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  logBackendRouteError: (line: string) => logBackendRouteErrorMock(line),
}));

import { postAdminReferralReview } from '@/lib/admin-referral-review-route-adapter-service';
import { POST } from '@/app/api/admin/referrals/route';

const SESSION_REVIEWER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ATTRIBUTION = 'bbbbbbbb-0000-4000-8000-000000000002';
const LINK = 'cccccccc-0000-4000-8000-000000000003';

function request(body: unknown, raw = false) {
  return new Request('https://example.com/api/admin/referrals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

function authenticated() {
  authenticateAdminRequestMock.mockResolvedValue({
    authenticated: true,
    identity: { subject: 'admin', username: 'admin', reviewerUserId: SESSION_REVIEWER },
  });
}

describe('admin referral review route', () => {
  beforeEach(() => {
    authenticateAdminRequestMock.mockReset();
    applyReferralReviewActionMock.mockReset();
    logBackendRouteErrorMock.mockReset();
  });

  it('rejects an unauthenticated caller before touching the service', async () => {
    authenticateAdminRequestMock.mockResolvedValue({ authenticated: false, reason: 'unauthenticated' });

    const response = await postAdminReferralReview(request({ action: 'block', attributionId: ATTRIBUTION, reason: 'A reason.' }));

    expect(response.status).toBe(401);
    expect(applyReferralReviewActionMock).not.toHaveBeenCalled();
  });

  it('reports an unconfigured console as 503 rather than a login failure', async () => {
    authenticateAdminRequestMock.mockResolvedValue({ authenticated: false, reason: 'unconfigured' });

    const response = await postAdminReferralReview(request({ action: 'block', attributionId: ATTRIBUTION, reason: 'A reason.' }));

    expect(response.status).toBe(503);
    expect(applyReferralReviewActionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', '{', true, 'Invalid request body.'],
    // JSON that parses but has no fields to read: it crashed the route with an unlogged 500.
    ['a JSON null body', 'null', true, 'Invalid request body.'],
    ['a JSON array body', '[]', true, 'Invalid request body.'],
    ['an action the program does not know', { action: 'pay', attributionId: ATTRIBUTION, reason: 'A reason.' }, false, 'Unsupported referral action.'],
    ['a block with no referral', { action: 'block', reason: 'A reason.' }, false, 'A referral id is required.'],
    ['a block that names a link instead', { action: 'block', referralCodeId: LINK, reason: 'A reason.' }, false, 'A referral id is required.'],
    ['a link switch that names a referral instead', { action: 'disable_link', attributionId: ATTRIBUTION, reason: 'A reason.' }, false, 'An invite link id is required.'],
    ['an id that is not a uuid', { action: 'unblock', attributionId: 'attribution-1', reason: 'A reason.' }, false, 'A referral id is required.'],
    ['no reason', { action: 'block', attributionId: ATTRIBUTION }, false, 'Give a reason of 3 to 1000 characters.'],
    ['a reason of two characters', { action: 'block', attributionId: ATTRIBUTION, reason: ' ok ' }, false, 'Give a reason of 3 to 1000 characters.'],
    ['a reason past the limit', { action: 'block', attributionId: ATTRIBUTION, reason: 'x'.repeat(1001) }, false, 'Give a reason of 3 to 1000 characters.'],
  ])('refuses %s without deciding anything', async (_name, body, raw, error) => {
    authenticated();

    const response = await postAdminReferralReview(request(body, raw));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(applyReferralReviewActionMock).not.toHaveBeenCalled();
  });

  it('decides as the session’s reviewer, never one the body names', async () => {
    authenticated();
    applyReferralReviewActionMock.mockResolvedValue({ ok: true, status: 'updated' });

    const response = await POST(request({
      action: 'block',
      attributionId: ATTRIBUTION,
      referralCodeId: LINK,
      reason: '  Two accounts, one person.  ',
      reviewerUserId: 'eeeeeeee-0000-4000-8000-000000000005',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, status: 'updated' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(applyReferralReviewActionMock).toHaveBeenCalledWith({ service: 'admin' }, {
      action: 'block',
      subjectId: ATTRIBUTION,
      reason: 'Two accounts, one person.',
      reviewerUserId: SESSION_REVIEWER,
    });
  });

  it('switches a link by the link’s id', async () => {
    authenticated();
    applyReferralReviewActionMock.mockResolvedValue({ ok: true, status: 'unchanged' });

    const response = await postAdminReferralReview(request({ action: 'enable_link', referralCodeId: LINK, reason: 'Reviewed with the creator.' }));

    await expect(response.json()).resolves.toEqual({ success: true, status: 'unchanged' });
    expect(applyReferralReviewActionMock).toHaveBeenCalledWith({ service: 'admin' }, expect.objectContaining({
      action: 'enable_link',
      subjectId: LINK,
    }));
  });

  it.each([
    [{ ok: false, code: 'not_found', error: 'That referral or invite link no longer exists.' }, 404],
    [{ ok: false, code: 'account_deleted', error: 'The inviter deleted their account; the link stays off.' }, 400],
    [{ ok: false, code: 'invalid', error: 'a reason of 3 to 1000 characters is required' }, 400],
  ])('passes a refusal on with its reason: %j', async (result, status) => {
    authenticated();
    applyReferralReviewActionMock.mockResolvedValue(result);

    const response = await postAdminReferralReview(request({ action: 'disable_link', referralCodeId: LINK, reason: 'A reason.' }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: result.error, code: result.code });
  });

  it('answers a failure it cannot explain without the database’s words, and logs them', async () => {
    authenticated();
    applyReferralReviewActionMock.mockRejectedValue(new Error('relation "referral_review_events" does not exist'));

    const response = await postAdminReferralReview(request({ action: 'block', attributionId: ATTRIBUTION, reason: 'A reason.' }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'The decision could not be saved.' });
    expect(logBackendRouteErrorMock).toHaveBeenCalledTimes(1);
    expect(logBackendRouteErrorMock.mock.calls[0][0]).toContain('admin_referral_review_failed');
    expect(logBackendRouteErrorMock.mock.calls[0][0]).toContain('referral_review_events');
  });
});
