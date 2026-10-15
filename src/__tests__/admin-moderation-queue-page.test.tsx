import { PassThrough } from 'node:stream';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMock = vi.hoisted(() => ({ refresh: vi.fn() }));
const collectAdminModerationQueueMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

vi.mock('@/lib/admin-auth', () => ({ requireAdminIdentity: vi.fn(async () => ({ subject: 'master', username: 'admin', reviewerUserId: '10000000-0000-4000-8000-000000000001' })) }));

vi.mock('@/lib/admin-moderation-service', () => ({
  collectAdminModerationQueue: (client: unknown, options: unknown) => (
    collectAdminModerationQueueMock(client, options)
  ),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} />,
}));

import AdminModerationPage from '@/app/admin/(console)/moderation/page';
import { SubjectReportActions } from '@/app/admin/(console)/moderation/ModerationActions';

const TEMPLATE_REPORT_ID = '20000000-0000-4000-8000-000000000002';
const COMMENT_REPORT_ID = '30000000-0000-4000-8000-000000000003';
const TEMPLATE_ID = '40000000-0000-4000-8000-000000000004';
const CREATOR_ID = '50000000-0000-4000-8000-000000000005';
const REPORTER_ID = '60000000-0000-4000-8000-000000000006';

/** React SSR splits adjacent text with `<!-- -->` markers; read the page the way it reads on screen. */
function visibleText(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

/** Streams the server tree the way production does; see admin-moderation-history-page.test.tsx. */
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

function subjectReport(overrides: Record<string, unknown>) {
  return {
    reporterUserId: REPORTER_ID,
    reportedUserId: null,
    generationId: null,
    commentId: null,
    templateId: null,
    details: null,
    status: 'open' as const,
    createdAt: '2026-10-15T02:00:00.000Z',
    updatedAt: '2026-10-15T02:00:00.000Z',
    reviewedAt: null,
    reviewedBy: null,
    comment: null,
    template: null,
    ...overrides,
  };
}

function queue() {
  return {
    postReports: [],
    subjectReports: [
      subjectReport({
        id: TEMPLATE_REPORT_ID,
        targetType: 'template',
        templateId: TEMPLATE_ID,
        reason: 'stolen_content',
        details: 'The demo is my video.',
        sourceSurface: 'template-detail',
        template: {
          id: TEMPLATE_ID,
          name: 'Neon portrait',
          slug: 'neon-portrait',
          description: 'Turns a selfie into a neon poster.',
          status: 'active',
          creatorUserId: CREATOR_ID,
        },
      }),
      subjectReport({
        id: COMMENT_REPORT_ID,
        targetType: 'comment',
        commentId: '70000000-0000-4000-8000-000000000007',
        reason: 'harassment',
        sourceSurface: 'comments',
        comment: {
          id: '70000000-0000-4000-8000-000000000007',
          postId: '80000000-0000-4000-8000-000000000008',
          parentId: null,
          authorUserId: '90000000-0000-4000-8000-000000000009',
          body: 'A reported comment',
          status: 'active',
        },
      }),
    ],
    openCount: 2,
    oldestOpenAt: '2026-10-15T02:00:00.000Z',
  };
}

describe('admin moderation queue page', () => {
  beforeEach(() => {
    routerMock.refresh.mockReset();
    collectAdminModerationQueueMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a template report with its title, its creator and a link to its page', async () => {
    collectAdminModerationQueueMock.mockResolvedValue(queue());

    const html = visibleText(await renderPageToHtml(await AdminModerationPage()));

    expect(html).toContain('User, generation, comment &amp; template reports (2)');
    expect(html).toContain('Reported template');
    expect(html).toContain('Neon portrait');
    expect(html).toContain('Turns a selfie into a neon poster.');
    expect(html).toContain('href="/templates/neon-portrait"');
    expect(html).toContain(`href="/admin/users/${CREATOR_ID}"`);
    expect(html).toContain('Created by');
    expect(html).toContain('stolen content');
    // Resolving a template report is the take-down; a comment report keeps its own control.
    expect(html).toContain('Take down template');
    expect(html).toContain('Complete any required manual safety action before resolving.');
    expect(html).toContain('A reported comment');
  });

  it('takes the template down from the queue and says what that did', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'resolved',
        targetType: 'template',
        templateDisabled: true,
        resolvedReportCount: 2,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SubjectReportActions reportId={TEMPLATE_REPORT_ID} targetType="template" />);
    fireEvent.change(screen.getByLabelText('Resolution note (required)'), {
      target: { value: 'Stolen demo media under policy 3.1.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take down template' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Report resolved. The template was disabled: it left the catalog and no new run can start. '
      + '2 duplicate reports for the same target were closed too.',
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/moderation/subject-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportId: TEMPLATE_REPORT_ID,
        action: 'resolve',
        note: 'Stolen demo media under policy 3.1.',
      }),
    });
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the template was already down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'resolved', targetType: 'template', templateDisabled: false, resolvedReportCount: 1 }),
    })));

    render(<SubjectReportActions reportId={TEMPLATE_REPORT_ID} targetType="template" />);
    fireEvent.change(screen.getByLabelText('Resolution note (required)'), {
      target: { value: 'The creator disabled it first.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Take down template' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Report resolved. The template was already disabled.');
  });
});
