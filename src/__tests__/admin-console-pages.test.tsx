import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const collectAdminSystemSnapshotMock = vi.fn();
const listOpenCreatorPayoutRequestsMock = vi.fn();
const listResolvedCreatorPayoutRequestsMock = vi.fn();

vi.mock('@/lib/admin-system-service', () => ({
  CONTACT_PAGE_SIZE: 25,
  collectAdminSystemSnapshot: (client: unknown, options: unknown) => (
    collectAdminSystemSnapshotMock(client, options)
  ),
}));

vi.mock('@/app/admin/(console)/system/ContactTriageControls', () => ({
  ContactTriageControls: ({ isHandled }: { isHandled: boolean }) => (
    <div data-testid="triage" data-handled={String(isHandled)} />
  ),
}));

vi.mock('@/lib/creator-payout-ops', () => ({
  listOpenCreatorPayoutRequests: (client: unknown) => listOpenCreatorPayoutRequestsMock(client),
  listResolvedCreatorPayoutRequests: (client: unknown, options: unknown) => (
    listResolvedCreatorPayoutRequestsMock(client, options)
  ),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));

vi.mock('@/app/admin/(console)/payouts/PayoutActions', () => ({
  PayoutActions: () => <div data-testid="payout-actions" />,
}));

import AdminPayoutsPage from '@/app/admin/(console)/payouts/page';
import AdminSystemPage from '@/app/admin/(console)/system/page';

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

function systemSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    jobSummaries: [],
    recentRuns: [],
    locks: [],
    catalog: { activeRevision: null, activeStatus: null, activatedAt: null, entryCount: 0, releases: [] },
    contactMessages: [{
      id: 'c1',
      name: 'Asha Rao',
      email: 'asha@example.com',
      subject: 'Refund for a failed video',
      message: 'My generation failed twice and the credits were not returned.\nOrder #4821.',
      createdAt: '2026-08-18T10:00:00.000Z',
      handledAt: null,
      handledBy: null,
      handledNote: null,
    }],
    contactMessageTotal: 1,
    contactOffset: 0,
    ...overrides,
  };
}

describe('admin system page — contact queue', () => {
  it('renders the enquiry body, which the table view never fetched at all', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot());

    const html = await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('My generation failed twice and the credits were not returned.');
    expect(html).toContain('Order #4821.');
    expect(html).toContain('Refund for a failed video');
    expect(html).toContain('asha@example.com');
  });

  it('offers a prefilled reply without exposing the address as a bare link target', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot());

    const html = await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('mailto:asha@example.com?subject=Re%3A%20Refund%20for%20a%20failed%20video');
  });

  it('keeps the queue scannable by collapsing bodies behind a summary', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot());

    const html = await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    // Collapsed by default: no `open` attribute on the disclosure.
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('defaults the queue to open enquiries so it shrinks as it is worked', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot());

    await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({}) }),
    );

    expect(collectAdminSystemSnapshotMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ contactFilter: 'open' }),
    );
  });

  it('offers a triage control for each enquiry', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot());

    const html = await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('data-testid="triage"');
    expect(html).toContain('data-handled="false"');
  });

  it('passes the URL offset through to the snapshot query', async () => {
    collectAdminSystemSnapshotMock.mockResolvedValue(systemSnapshot({ contactOffset: 25 }));

    await renderPageToHtml(
      await AdminSystemPage({ searchParams: Promise.resolve({ contact: '25' }) }),
    );

    expect(collectAdminSystemSnapshotMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { contactOffset: 25, contactFilter: 'open' },
    );
  });
});

describe('admin payouts page — settled history', () => {
  const settled = {
    requests: [{
      id: 'p1',
      userId: '50000000-0000-4000-8000-000000000005',
      username: 'creator',
      displayName: 'Creator One',
      amountTokenSubunits: 1_200_000,
      amountUsd: '$120.00',
      payoutMethod: 'UPI',
      status: 'paid' as const,
      requestedAt: '2026-08-01T00:00:00.000Z',
      resolvedAt: '2026-08-04T12:00:00.000Z',
      resolvedBy: '30000000-0000-4000-8000-000000000003',
      resolutionNote: 'Sent via NEFT.',
      externalReference: 'UTR9912',
    }],
    total: 1,
    offset: 0,
  };

  it('shows a settled payout so "did we already pay this creator?" is answerable', async () => {
    listOpenCreatorPayoutRequestsMock.mockResolvedValue([]);
    listResolvedCreatorPayoutRequestsMock.mockResolvedValue(settled);

    const html = await renderPageToHtml(
      await AdminPayoutsPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('Settled payouts');
    expect(html).toContain('$120.00');
    expect(html).toContain('UTR9912');
    expect(html).toContain('Sent via NEFT.');
    expect(html).toContain('Creator One');
    expect(visibleText(html)).toContain('4 Aug 2026');
  });

  /**
   * The open queue decrypts and shows the destination because the operator
   * needs it to send the money. Once settled that need is gone, so the history
   * must not re-render a bank handle on a long scrollable list.
   */
  it('never renders the payout destination in the settled history', async () => {
    listOpenCreatorPayoutRequestsMock.mockResolvedValue([]);
    listResolvedCreatorPayoutRequestsMock.mockResolvedValue(settled);

    const html = await renderPageToHtml(
      await AdminPayoutsPage({ searchParams: Promise.resolve({}) }),
    );

    // The service never selects payout_details, so nothing can leak into the row.
    expect(listResolvedCreatorPayoutRequestsMock).toHaveBeenCalled();
    expect(html).not.toContain('payoutDetails');
    expect(html).toContain('UPI');
  });
});
