import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const getAdminUserDetailMock = vi.fn();

vi.mock('@/lib/admin-users-service', () => ({
  getAdminUserDetail: (client: unknown, userId: string) => getAdminUserDetailMock(client, userId),
}));
vi.mock('@/lib/admin-credit-adjustment-service', () => ({
  listAdminCreditAdjustments: vi.fn(async () => []),
}));
vi.mock('@/lib/admin-user-sanction-service', () => ({
  listAdminUserSanctions: vi.fn(async () => []),
  getAdminUserAccountState: vi.fn(async () => ({ isSuspended: false, bannedUntil: null })),
}));
vi.mock('@/lib/server-helpers', () => ({ createServiceClient: () => ({ from: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));
vi.mock('@/app/admin/(console)/users/[userId]/CreditAdjustmentForm', () => ({
  CreditAdjustmentForm: () => <div data-testid="credit-form" />,
}));
vi.mock('@/app/admin/(console)/users/[userId]/UserSanctionForm', () => ({
  UserSanctionForm: () => <div data-testid="sanction-form" />,
}));

import AdminUserDetailPage from '@/app/admin/(console)/users/[userId]/page';

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

const MISSING_ID = '00000000-0000-4000-8000-00000000dead';

describe('admin user detail — unresolvable id', () => {
  /**
   * Deliberately not `notFound()`. A not-found boundary was tried at the console
   * group, at /admin and at the app root; none render in this app, so notFound()
   * fell through to Next's built-in shell and dropped the operator out of the
   * console entirely. Rendering inline is what keeps the sidebar.
   */
  it('renders a recoverable panel instead of dead-ending the operator', async () => {
    getAdminUserDetailMock.mockResolvedValue(null);

    const html = await renderPageToHtml(
      await AdminUserDetailPage({ params: Promise.resolve({ userId: MISSING_ID }) }),
    );

    expect(html).toContain('No user with that id');
    expect(html).toContain(MISSING_ID);
    expect(html).toContain('href="/admin/users"');
  });

  it('does not render the support record or any action form', async () => {
    getAdminUserDetailMock.mockResolvedValue(null);

    const html = await renderPageToHtml(
      await AdminUserDetailPage({ params: Promise.resolve({ userId: MISSING_ID }) }),
    );

    // Nothing actionable should be offered against an account that is not there.
    expect(html).not.toContain('data-testid="credit-form"');
    expect(html).not.toContain('data-testid="sanction-form"');
  });

  it('treats a lookup failure the same as a missing user rather than throwing', async () => {
    getAdminUserDetailMock.mockRejectedValue(new Error('PostgREST exploded'));

    const html = await renderPageToHtml(
      await AdminUserDetailPage({ params: Promise.resolve({ userId: MISSING_ID }) }),
    );

    expect(html).toContain('No user with that id');
  });
});
