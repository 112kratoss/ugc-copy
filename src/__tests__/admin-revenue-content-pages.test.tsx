import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const collectAdminRevenueReportMock = vi.fn();
const collectAdminContentSnapshotMock = vi.fn();

vi.mock('@/lib/admin-auth', () => ({ requireAdminIdentity: vi.fn(async () => ({ subject: 'master', username: 'admin', reviewerUserId: '10000000-0000-4000-8000-000000000001' })) }));

vi.mock('@/lib/admin-revenue-service', () => ({
  collectAdminRevenueReport: (client: unknown, options: unknown) => collectAdminRevenueReportMock(client, options),
}));

vi.mock('@/lib/admin-content-service', () => ({
  collectAdminContentSnapshot: (client: unknown, options: unknown) => collectAdminContentSnapshotMock(client, options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));

vi.mock('@/app/admin/(console)/content/PostModerationControls', () => ({
  PostModerationControls: () => <div data-testid="post-moderation" />,
}));

import AdminContentPage from '@/app/admin/(console)/content/page';
import AdminRevenuePage from '@/app/admin/(console)/revenue/page';

function renderPageToHtml(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sink.on('error', reject);

    const { pipe } = renderToPipeableStream(element, {
      onAllReady() { pipe(sink); },
      onError(error) { reject(error); },
    });
  });
}

/** React SSR splits adjacent text nodes with `<!-- -->` hydration markers. */
function visibleText(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

function rail(overrides: Record<string, unknown>) {
  return {
    succeededCount: 0,
    freeCount: 0,
    pendingCount: 0,
    failedCount: 0,
    totalsByCurrency: [],
    creditsIssued: null,
    ...overrides,
  };
}

function revenueReport(overrides: Record<string, unknown> = {}) {
  return {
    windowDays: 30,
    since: '2026-10-15T00:00:00.000Z',
    rails: [
      rail({ key: 'razorpay-credits', label: 'Credit purchases (web)', pendingCount: 3 }),
      rail({ key: 'mobile-iap', label: 'Mobile in-app purchases (nominal list price)' }),
      rail({ key: 'marketplace', label: 'Marketplace assets' }),
      rail({
        key: 'resource-bundles',
        label: 'Post resource bundles',
        succeededCount: 1,
        freeCount: 13,
        totalsByCurrency: [{ currency: 'USD', grossSubunits: 499, succeededCount: 1 }],
      }),
    ],
    recentOrders: [{
      id: 'o1',
      rail: 'razorpay-credits',
      status: 'created',
      amountSubunits: 41500,
      currency: 'INR',
      userId: '20000000-0000-4000-8000-000000000002',
      createdAt: '2026-11-07T08:16:00.000Z',
      reference: null,
    }],
    orderTotal: 1,
    orderOffset: 0,
    orderPageSize: 60,
    ordersTruncated: false,
    creatorPayouts: { walletCount: 1, availableTokenSubunits: 1_100_000, lifetimeEarnedTokenSubunits: 85_000 },
    ...overrides,
  };
}

describe('admin revenue page', () => {
  it('shows creator wallets in dollars, the unit the wallet and payouts use', async () => {
    // 1,100,000 token subunits = 11,000 tokens = $110.00. Read as rupee paise it
    // printed "₹11,000.00 owed", while Payouts said $0.00 owed.
    collectAdminRevenueReportMock.mockResolvedValue(revenueReport());

    const html = visibleText(await renderPageToHtml(await AdminRevenuePage({ searchParams: Promise.resolve({}) })));

    expect(html).toContain('$110.00 owed');
    expect(html).not.toContain('₹11,000');
  });

  it('counts paid orders apart from free unlocks and unpaid checkouts', async () => {
    collectAdminRevenueReportMock.mockResolvedValue(revenueReport());

    const html = visibleText(await renderPageToHtml(await AdminRevenuePage({ searchParams: Promise.resolve({}) })));

    expect(html).toContain('Paid orders');
    expect(html).toContain('13 free unlocks');
    expect(html).toContain('Checkouts opened but never paid');
    // A Razorpay order still `created` was never paid.
    expect(html).toContain('not paid');
    expect(html).not.toContain('>created<');
  });
});

function contentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    posts: [{
      id: '30000000-0000-4000-8000-000000000003',
      userId: '20000000-0000-4000-8000-000000000002',
      title: 'Kung fu cats',
      visibility: 'public',
      reviewStatus: 'visible',
      postFormat: 'media',
      category: 'image',
      reportCount: 0,
      saveCount: 1,
      commentCount: 0,
      createdAt: '2026-03-20T08:00:00.000Z',
    }],
    generations: [],
    totals: { posts: 47, privatePosts: 13, hiddenPosts: 0, generations24h: 0, failedGenerations24h: 0 },
    pageTotals: { posts: 1, generations: 0 },
    pageOffsets: { posts: 0, generations: 0 },
    ...overrides,
  };
}

describe('admin content page', () => {
  it('links each post to its page at /showcase/<id>', async () => {
    collectAdminContentSnapshotMock.mockResolvedValue(contentSnapshot());

    const html = await renderPageToHtml(await AdminContentPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('href="/showcase/30000000-0000-4000-8000-000000000003"');
    expect(html).not.toContain('href="/post/');
  });

  it('calls a creator\'s private posts private, apart from posts moderation hid', async () => {
    collectAdminContentSnapshotMock.mockResolvedValue(contentSnapshot());

    const html = visibleText(await renderPageToHtml(await AdminContentPage({ searchParams: Promise.resolve({}) })));

    expect(html).toContain('Private posts');
    expect(html).toContain('0 hidden by moderation');
    expect(html).not.toContain('Hidden posts');
    expect(html).toContain('posts=private');
    expect(html).toContain('posts=hidden');
  });
});
