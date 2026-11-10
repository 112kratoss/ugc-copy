import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdminReferralOverviewMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/admin-auth', () => ({
  requireAdminIdentity: vi.fn(async () => ({ subject: 'master', username: 'admin', reviewerUserId: '10000000-0000-4000-8000-000000000001' })),
}));

vi.mock('@/lib/admin-referrals-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/admin-referrals-service')>(),
  getAdminReferralOverview: (client: unknown, options: unknown) => getAdminReferralOverviewMock(client, options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));

vi.mock('@/app/admin/(console)/referrals/ReferralReviewActions', () => ({
  ReferralReviewActions: (props: { attributionId: string; rewardState: string; inviterCode: { id: string; enabled: boolean } | null }) => (
    <div
      data-testid="referral-actions"
      data-attribution={props.attributionId}
      data-state={props.rewardState}
      data-link={props.inviterCode ? `${props.inviterCode.id}:${props.inviterCode.enabled}` : 'none'}
    />
  ),
}));

import AdminReferralsPage from '@/app/admin/(console)/referrals/page';

function renderPageToHtml(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/<!-- -->/g, '')));
    sink.on('error', reject);

    const { pipe } = renderToPipeableStream(element, {
      onAllReady() { pipe(sink); },
      onError(error) { reject(error); },
    });
  });
}

const INVITER = '50000000-0000-4000-8000-000000000001';
const FRIEND = '50000000-0000-4000-8000-000000000002';
const GONE = '50000000-0000-4000-8000-000000000009';

function overview(overrides: Record<string, unknown> = {}) {
  return {
    stats: { inviteLinks: 12, disabledLinks: 1, referrals: 3, blocked: 1, flagged: 1 },
    filter: 'all',
    referrals: [
      {
        id: 'attribution-blocked',
        attributedAt: '2026-11-02T10:00:00.000Z',
        rewardState: 'blocked',
        rewardStateReason: 'same_device_as_inviter',
        rewardStateSource: 'system',
        rewardStateChangedAt: '2026-11-02T10:00:00.000Z',
        riskFlags: [],
        inviter: { userId: INVITER, detachedUserId: null, username: 'inviter', displayName: 'The Inviter' },
        invitee: { userId: FRIEND, detachedUserId: null, username: 'friend', displayName: null },
        settledPurchases: 0,
        activeRewardCredits: 0,
        inviterCode: { id: 'code-1', enabled: false, disabledReason: 'Repeated self-invites.' },
      },
      {
        id: 'attribution-paying',
        attributedAt: '2026-11-01T10:00:00.000Z',
        rewardState: 'eligible',
        rewardStateReason: 'A shared family laptop; two people.',
        rewardStateSource: 'operator',
        rewardStateChangedAt: '2026-11-03T09:30:00.000Z',
        riskFlags: ['same_network', 'shared_device'],
        inviter: { userId: null, detachedUserId: GONE, username: null, displayName: null },
        invitee: { userId: FRIEND, detachedUserId: null, username: 'friend', displayName: null },
        settledPurchases: 2,
        activeRewardCredits: 1250,
        inviterCode: null,
      },
    ],
    total: 2,
    offset: 0,
    pageSize: 25,
    detailTruncated: false,
    ...overrides,
  };
}

describe('admin referrals page', () => {
  beforeEach(() => {
    getAdminReferralOverviewMock.mockReset();
  });

  it('shows the program’s counts, with the links that are switched off', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview());

    const html = await renderPageToHtml(await AdminReferralsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('Referrals');
    expect(html).toContain('Invite links');
    expect(html).toContain('1 switched off');
    expect(html).toContain('A hint, not a block');
  });

  it('says in plain words why the guard blocked a referral, and who each account is', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview());

    const html = await renderPageToHtml(await AdminReferralsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('Signed up on the inviter’s own device');
    expect(html).not.toContain('same_device_as_inviter');
    expect(html).toContain('Guard · 2 Nov 2026');
    expect(html).toContain(`href="/admin/users/${INVITER}"`);
    expect(html).toContain('The Inviter');
    expect(html).toContain('@friend');
    expect(html).toContain('Link switched off');
  });

  it('shows an operator’s own reason as written, the flags as hints, and what the referral has paid', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview());

    const html = await renderPageToHtml(await AdminReferralsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('A shared family laptop; two people.');
    expect(html).toContain('Operator · 3 Nov 2026');
    expect(html).toContain('Same network as the inviter');
    expect(html).toContain('Device also used by another account');
    expect(html).toContain('1,250');
  });

  it('labels a deleted inviter by the id the history kept, with no link and no switch', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview());

    const html = await renderPageToHtml(await AdminReferralsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('Deleted account');
    expect(html).toContain(GONE);
    expect(html).not.toContain(`/admin/users/${GONE}`);
    expect(html).toContain('data-attribution="attribution-paying" data-state="eligible" data-link="none"');
    expect(html).toContain('data-attribution="attribution-blocked" data-state="blocked" data-link="code-1:false"');
  });

  it('asks the service for the filter and page the address names, and keeps the filter in the pager', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview({ filter: 'flagged', total: 60, offset: 25 }));

    const html = await renderPageToHtml(
      await AdminReferralsPage({ searchParams: Promise.resolve({ state: 'flagged', offset: '25' }) }),
    );

    expect(getAdminReferralOverviewMock).toHaveBeenCalledWith(expect.anything(), { filter: 'flagged', offset: 25 });
    expect(html).toContain('href="/admin/referrals?state=flagged" aria-current="page"');
    expect(html).toContain('href="/admin/referrals?state=flagged&amp;offset=50"');
    expect(html).toContain('href="/admin/referrals?state=flagged"');
  });

  it('reads a filter it does not know as all, and says when nothing matches', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview({ referrals: [], total: 0 }));

    const html = await renderPageToHtml(
      await AdminReferralsPage({ searchParams: Promise.resolve({ state: 'paid', offset: '-4' }) }),
    );

    expect(getAdminReferralOverviewMock).toHaveBeenCalledWith(expect.anything(), { filter: 'all', offset: 0 });
    expect(html).toContain('No referrals yet.');
  });

  it('says when a page’s totals are a floor', async () => {
    getAdminReferralOverviewMock.mockResolvedValue(overview({ detailTruncated: true }));

    const html = await renderPageToHtml(await AdminReferralsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('its totals are a floor');
  });
});
