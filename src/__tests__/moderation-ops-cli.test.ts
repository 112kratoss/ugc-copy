import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostReportResolution } from '@/lib/moderation-ops';

const moderation = vi.hoisted(() => ({
  listOpenModerationReports: vi.fn(),
  resolvePostReport: vi.fn(),
  resolveSubjectReport: vi.fn(),
}));

vi.mock('@/lib/moderation-ops', () => moderation);
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

const REPORT_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const REVIEWER_ID = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const ENVIRONMENT: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.test',
  CRON_SECRET: 'cron-secret-test',
};

function resolution(overrides: Partial<PostReportResolution>): PostReportResolution {
  return {
    status: 'taken_down',
    reportId: REPORT_ID,
    postId: 'post-1',
    reportStatus: 'resolved',
    reviewedAt: '2026-11-04T12:00:00.000Z',
    reviewedBy: REVIEWER_ID,
    ...overrides,
  };
}

async function run(
  command: string,
  {
    environment = ENVIRONMENT,
    fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
  }: { environment?: NodeJS.ProcessEnv; fetchImpl?: ReturnType<typeof vi.fn> } = {},
) {
  const { runModerationOps } = await import('../../scripts/ops/moderation-ops');
  const notes: string[] = [];
  await runModerationOps(
    [command, '--report-id', REPORT_ID, '--reviewer-id', REVIEWER_ID, '--note', 'Policy 4.2: evidence', '--confirm'],
    environment,
    { fetch: fetchImpl as unknown as typeof fetch, note: (message) => { notes.push(message); } },
  );
  return { fetchImpl, notes };
}

describe('moderation CLI: refreshing the feed after a post decision', () => {
  beforeEach(() => {
    moderation.resolvePostReport.mockReset();
    moderation.resolveSubjectReport.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the app to refresh its cached feed pages after a take-down', async () => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { fetchImpl, notes } = await run('take-down-post');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://magicbooklet.test/api/cron/showcase-feed-invalidate');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cron-secret-test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(notes).toEqual(['Refreshed the feed\'s cached pages at https://magicbooklet.test.']);
  });

  it.each([
    ['a dismissal, which can return a flagged post to the feed', 'dismiss-post', resolution({ status: 'dismissed' }), 1],
    ['a rerun of a take-down, which retries the refresh', 'take-down-post', resolution({ status: 'already_resolved', resolutionAction: 'take_down' }), 1],
    ['a rerun of a dismissal, which changed nothing this time', 'dismiss-post', resolution({ status: 'already_resolved', resolutionAction: 'dismiss' }), 0],
  ])('refreshes after %s as it should', async (_case, command, result, calls) => {
    moderation.resolvePostReport.mockResolvedValue(result);

    const { fetchImpl } = await run(command);

    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('leaves the feed alone for a subject report', async () => {
    moderation.resolveSubjectReport.mockResolvedValue({ status: 'resolved', targetType: 'comment' });

    const { fetchImpl, notes } = await run('resolve-subject');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it.each([
    ['CRON_SECRET is not set', { ...ENVIRONMENT, CRON_SECRET: '' }, 'https://magicbooklet.test'],
    ['NEXT_PUBLIC_SITE_URL is not set', { ...ENVIRONMENT, NEXT_PUBLIC_SITE_URL: '  ' }, 'https://magicbooklet.com'],
    ['NEXT_PUBLIC_SITE_URL is not a URL', { ...ENVIRONMENT, NEXT_PUBLIC_SITE_URL: 'magicbooklet' }, 'magicbooklet'],
  ])('keeps the take-down and gives the command to run by hand when %s', async (reason, environment, site) => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { fetchImpl, notes } = await run('take-down-post', { environment });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`(${reason})`);
    expect(notes[0]).toContain('up to 15 minutes');
    expect(notes[0]).toContain(
      `curl -fsS -H "Authorization: Bearer $CRON_SECRET" ${site}/api/cron/showcase-feed-invalidate`,
    );
  });

  it.each([
    ['the app refuses it', vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 })), 'https://magicbooklet.test answered 401'],
    ['the request fails', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }), 'the request to https://magicbooklet.test failed: getaddrinfo ENOTFOUND'],
  ])('keeps the take-down and warns when %s', async (_case, fetchImpl, reason) => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { notes } = await run('take-down-post', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(notes).toEqual([expect.stringContaining(`(${reason})`)]);
    expect(notes[0]).toContain('curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://magicbooklet.test/api/cron/showcase-feed-invalidate');
  });

  it('never prints the secret, and takes a site address with a trailing slash', async () => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));
    const failing = vi.fn(async () => new Response('', { status: 503 }));

    const { fetchImpl, notes } = await run('take-down-post', {
      environment: { ...ENVIRONMENT, NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.test/' },
      fetchImpl: failing,
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://magicbooklet.test/api/cron/showcase-feed-invalidate');
    expect(JSON.stringify(notes)).not.toContain('cron-secret-test');
    expect(notes[0]).toContain('$CRON_SECRET');
  });
});
