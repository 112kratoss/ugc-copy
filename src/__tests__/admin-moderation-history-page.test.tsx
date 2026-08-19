import { PassThrough } from 'node:stream';

import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const collectAdminModerationHistoryMock = vi.fn();

vi.mock('@/lib/admin-moderation-service', () => ({
  ADMIN_MODERATION_HISTORY_PAGE_SIZE: 25,
  collectAdminModerationHistory: (client: unknown, options: unknown) => (
    collectAdminModerationHistoryMock(client, options)
  ),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));

import AdminModerationHistoryPage from '@/app/admin/(console)/moderation/history/page';

const REVIEWER_ID = '30000000-0000-4000-8000-000000000003';
const UNKNOWN_REVIEWER_ID = '60000000-0000-4000-8000-000000000006';

/**
 * React SSR separates adjacent interpolated text nodes with `<!-- -->` hydration
 * markers, so rendered copy is never contiguous in the raw HTML. Strip them so
 * assertions can be written the way the sentence actually reads on screen.
 */
function visibleText(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

/** Streams the server tree the way production does; see anonymous-home-page-cache.test.tsx. */
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

function history(overrides: Record<string, unknown> = {}) {
  return {
    postReports: [{
      id: '10000000-0000-4000-8000-000000000001',
      postId: '20000000-0000-4000-8000-000000000002',
      bundleId: null,
      reporterUserId: null,
      reason: 'nudity',
      details: null,
      status: 'reviewed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      reviewedAt: '2026-08-02T09:30:00.000Z',
      reviewedBy: REVIEWER_ID,
      resolutionAction: 'take_down',
      resolutionNote: 'Violates policy section 4.2.',
      post: {
        id: '20000000-0000-4000-8000-000000000002',
        userId: '50000000-0000-4000-8000-000000000005',
        title: 'A reported post',
        visibility: 'public',
        reviewStatus: 'hidden',
        reportCount: 2,
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    }],
    subjectReports: [{
      id: '40000000-0000-4000-8000-000000000004',
      reporterUserId: null,
      targetType: 'user' as const,
      reportedUserId: '50000000-0000-4000-8000-000000000005',
      generationId: null,
      commentId: null,
      reason: 'harassment',
      details: null,
      sourceSurface: 'profile',
      status: 'dismissed' as const,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      reviewedAt: '2026-08-03T11:00:00.000Z',
      reviewedBy: UNKNOWN_REVIEWER_ID,
      resolutionNote: null,
      comment: null,
    }],
    reviewers: { [REVIEWER_ID]: { username: 'operator', displayName: 'Ops One' } },
    totals: { postReports: 120, subjectReports: 1 },
    pageSize: 25,
    postOffset: 0,
    subjectOffset: 0,
    ...overrides,
  };
}

describe('admin moderation history page', () => {
  it('renders the decision, the reviewer name and the rationale an appeal needs', async () => {
    collectAdminModerationHistoryMock.mockResolvedValue(history());

    const html = await renderPageToHtml(
      await AdminModerationHistoryPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('take down');
    expect(html).toContain('Violates policy section 4.2.');
    expect(html).toContain('Ops One');
    expect(html).toContain('A reported post');
    // The decision timestamp, not the report timestamp.
    expect(html).toContain('2 Aug 2026');
  });

  // A reviewer with no profile row must not drop the decision from the record.
  it('still lists a decision whose reviewer has no profile, and says a note is missing', async () => {
    collectAdminModerationHistoryMock.mockResolvedValue(history());

    const html = await renderPageToHtml(
      await AdminModerationHistoryPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('harassment');
    expect(html).toContain('No note recorded');
  });

  it('pages each family independently, preserving the other family\'s place', async () => {
    collectAdminModerationHistoryMock.mockResolvedValue(history({ postOffset: 25, subjectOffset: 0 }));

    const html = await renderPageToHtml(
      await AdminModerationHistoryPage({
        searchParams: Promise.resolve({ posts: '25' }),
      }),
    );

    expect(visibleText(html)).toContain('Showing 26–50 of 120 post decisions');
    // Advancing posts must carry the post cursor, not reset it.
    expect(html).toContain('href="/admin/moderation/history?posts=50"');
    // The single-page subject list renders a count, not controls.
    expect(visibleText(html)).toContain('1 subject decisions');
  });

  it('asks the service for the offsets parsed from the URL', async () => {
    collectAdminModerationHistoryMock.mockResolvedValue(history());

    await renderPageToHtml(
      await AdminModerationHistoryPage({
        searchParams: Promise.resolve({ posts: '50', subjects: '25' }),
      }),
    );

    expect(collectAdminModerationHistoryMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { postOffset: 50, subjectOffset: 25 },
    );
  });
});
