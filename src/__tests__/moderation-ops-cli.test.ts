import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PostReportResolution } from '@/lib/moderation-ops';

const moderation = vi.hoisted(() => ({
  listAgentPublishedPostsForModeration: vi.fn(),
  listOpenModerationReports: vi.fn(),
  resolvePostReport: vi.fn(),
  resolveSubjectReport: vi.fn(),
}));

vi.mock('@/lib/moderation-ops', () => moderation);
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));

const REPORT_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
/** The refresh the CLI tells an operator to run by hand, from the ugc-app folder. */
const MANUAL = (origin: string) => `curl -fsS -H "Authorization: Bearer $(node --env-file-if-exists=.env.local -p 'process.env.CRON_SECRET')" ${origin}/api/cron/showcase-feed-invalidate`;
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

describe('moderation CLI: the agent view of the queue', () => {
  beforeEach(() => {
    moderation.listOpenModerationReports.mockReset();
    moderation.listAgentPublishedPostsForModeration.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the posts agents published and the open reports of them with --source agent, as tables and as JSON', async () => {
    const agentPost = { postId: 'post-7', userId: 'user-1', clientId: 'client-claude', publishedAt: '2026-11-09T00:00:00.000Z', post: { id: 'post-7', userId: 'user-1', title: 'By an agent', visibility: 'public', reviewStatus: 'visible', reportCount: 1, createdAt: '2026-11-09T00:00:00.000Z' } };
    const snapshot = { postReports: [{ id: REPORT_ID, postId: 'post-7', reason: 'spam', details: null, post: agentPost.post, createdAt: 'x' }], subjectReports: [] };
    moderation.listOpenModerationReports.mockResolvedValue(snapshot);
    moderation.listAgentPublishedPostsForModeration.mockResolvedValue([agentPost]);
    const { runModerationOps } = await import('../../scripts/ops/moderation-ops');

    await runModerationOps(['list', '--source', 'agent', '--limit', '5'], ENVIRONMENT);
    expect(moderation.listOpenModerationReports).toHaveBeenCalledWith(expect.anything(), { limit: 5, source: 'agent' });
    expect(moderation.listAgentPublishedPostsForModeration).toHaveBeenCalledWith(expect.anything(), { limit: 5 });
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(logged).toContain('Posts published by agents: 1');
    expect(logged).toContain('Open post reports: 1');
    const tables = vi.mocked(console.table).mock.calls.map(([rows]) => rows as Array<Record<string, unknown>>);
    expect(tables[0]).toEqual([expect.objectContaining({ post_id: 'post-7', client_id: 'client-claude', post_status: 'visible', visibility: 'public', post_title: 'By an agent' })]);

    vi.mocked(console.log).mockClear();
    await runModerationOps(['list', '--source', 'agent', '--json'], ENVIRONMENT);
    const [json] = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(json).toEqual({ agentPosts: [agentPost], ...snapshot });
    // Without the flag the queue is the whole queue, and the agent list is not read.
    expect(moderation.listOpenModerationReports).toHaveBeenLastCalledWith(expect.anything(), { limit: undefined, source: 'agent' });
    moderation.listAgentPublishedPostsForModeration.mockClear();
    await runModerationOps(['list'], ENVIRONMENT);
    expect(moderation.listOpenModerationReports).toHaveBeenLastCalledWith(expect.anything(), { limit: undefined });
    expect(moderation.listAgentPublishedPostsForModeration).not.toHaveBeenCalled();
  });

  it('refuses a source it does not know', async () => {
    const { runModerationOps } = await import('../../scripts/ops/moderation-ops');
    await expect(runModerationOps(['list', '--source', 'web'], ENVIRONMENT)).rejects.toThrow('--source takes agent');
    expect(moderation.listOpenModerationReports).not.toHaveBeenCalled();
  });
});

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
    ['NEXT_PUBLIC_SITE_URL is not a URL', { ...ENVIRONMENT, NEXT_PUBLIC_SITE_URL: 'magicbooklet' }, 'https://magicbooklet.com'],
  ])('keeps the take-down and gives the command to run by hand when %s', async (reason, environment, site) => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { fetchImpl, notes } = await run('take-down-post', { environment });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`(${reason})`);
    expect(notes[0]).toContain('up to 15 minutes');
    expect(notes[0]).toContain(`  ${MANUAL(site)}`);
  });

  it.each([
    ['the app refuses it', vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 })), 'https://magicbooklet.test answered 401'],
    ['the request fails', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }), 'the request to https://magicbooklet.test failed: getaddrinfo ENOTFOUND'],
  ])('keeps the take-down and warns when %s', async (_case, fetchImpl, reason) => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { notes } = await run('take-down-post', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(notes).toEqual([expect.stringContaining(`(${reason})`)]);
    expect(notes[0]).toContain(MANUAL('https://magicbooklet.test'));
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
    // Read at run time from the shell or .env.local, never written into the command.
    expect(notes[0]).toContain("$(node --env-file-if-exists=.env.local -p 'process.env.CRON_SECRET')");
  });

  // The take-down commits before its media cleanup, which can fail after it:
  // the post may be hidden already, so the pages are refreshed before the
  // error goes on, and the exit code stays the error's.
  it.each([
    ['its media cleanup fails', new Error('Failed to delete taken-down post media from storage.')],
    ['it refuses media outside the post', new Error('Refusing to revoke a taken-down media path outside the reported post scope.')],
  ])('refreshes the pages when a take-down fails after its commit because %s, then fails as before', async (_case, failure) => {
    moderation.resolvePostReport.mockRejectedValue(failure);
    const { runModerationOps } = await import('../../scripts/ops/moderation-ops');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const notes: string[] = [];

    await expect(runModerationOps(
      ['take-down-post', '--report-id', REPORT_ID, '--reviewer-id', REVIEWER_ID, '--note', 'Policy 4.2', '--confirm'],
      ENVIRONMENT,
      { fetch: fetchImpl as unknown as typeof fetch, note: (message) => { notes.push(message); } },
    )).rejects.toBe(failure);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(notes).toEqual([
      "The decision may have been recorded before this failure: refreshing the feed's cached pages in case it was.",
      "Refreshed the feed's cached pages at https://magicbooklet.test.",
    ]);
  });

  it('still gives the command to run when a failed take-down cannot refresh the pages itself', async () => {
    const failure = new Error('Refusing to revoke a taken-down media path outside the reported post scope.');
    moderation.resolvePostReport.mockRejectedValue(failure);
    const { runModerationOps } = await import('../../scripts/ops/moderation-ops');
    const notes: string[] = [];

    await expect(runModerationOps(
      ['take-down-post', '--report-id', REPORT_ID, '--reviewer-id', REVIEWER_ID, '--confirm'],
      { ...ENVIRONMENT, CRON_SECRET: '' },
      { fetch: vi.fn() as unknown as typeof fetch, note: (message) => { notes.push(message); } },
    )).rejects.toBe(failure);

    expect(notes[1]).toContain('(CRON_SECRET is not set)');
    expect(notes[1]).toContain(MANUAL('https://magicbooklet.test'));
  });

  it('refreshes after a failed dismissal too, but not after a failed subject decision', async () => {
    const { runModerationOps } = await import('../../scripts/ops/moderation-ops');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const dependencies = { fetch: fetchImpl as unknown as typeof fetch, note: () => {} };
    moderation.resolvePostReport.mockRejectedValue(new Error('Post report resolver returned an invalid response.'));
    moderation.resolveSubjectReport.mockRejectedValue(new Error('Failed to resolve subject report'));

    await expect(runModerationOps(
      ['dismiss-post', '--report-id', REPORT_ID, '--reviewer-id', REVIEWER_ID, '--confirm'],
      ENVIRONMENT,
      dependencies,
    )).rejects.toThrow('invalid response');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(runModerationOps(
      ['resolve-subject', '--report-id', REPORT_ID, '--reviewer-id', REVIEWER_ID, '--note', 'Handled', '--confirm'],
      ENVIRONMENT,
      dependencies,
    )).rejects.toThrow('Failed to resolve subject report');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // A run against the production database with a local site address would
  // otherwise refresh only that server's pages and look done.
  it.each([
    ['a local server', 'http://localhost:3000'],
    ['a loopback address over https', 'https://127.0.0.1:3443'],
    ['a site over plain http', 'http://magicbooklet.com'],
  ])('warns when the site address is %s, and names the public refresh', async (_case, siteUrl) => {
    moderation.resolvePostReport.mockResolvedValue(resolution({ status: 'taken_down' }));

    const { fetchImpl, notes } = await run('take-down-post', {
      environment: { ...ENVIRONMENT, NEXT_PUBLIC_SITE_URL: siteUrl },
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${siteUrl}/api/cron/showcase-feed-invalidate`);
    expect(notes).toEqual([
      `Refreshed the feed's cached pages at ${siteUrl}.`,
      expect.stringContaining(`Warning: NEXT_PUBLIC_SITE_URL is ${siteUrl}, not the public site`),
    ]);
    expect(notes[1]).toContain(MANUAL('https://magicbooklet.com'));
  });

  // The printed command reads the secret as this CLI does, through Node's own
  // env-file parser. Run here for real in a shell, against a scratch file in
  // place of .env.local, with the value quoted every way a file may hold it.
  it.each([
    ['unquoted', 'CRON_SECRET=plain-secret', 'plain-secret'],
    ['double-quoted', 'CRON_SECRET="double quoted"', 'double quoted'],
    ['single-quoted', "CRON_SECRET='single quoted'", 'single quoted'],
  ])('reads an %s secret at run time without printing it', async (_case, line, value) => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const directory = mkdtempSync(path.join(tmpdir(), 'moderation-cli-'));
    try {
      const file = path.join(directory, 'secrets.txt');
      writeFileSync(file, `OTHER=1\n${line}\n`);
      const substitution = /\$\((node [^)]*)\)/.exec(MANUAL('https://magicbooklet.test'))?.[1];
      expect(substitution).toBe("node --env-file-if-exists=.env.local -p 'process.env.CRON_SECRET'");

      const read = execFileSync('/bin/sh', ['-c', `printf %s "$(${substitution!.replace('.env.local', file)})"`], {
        encoding: 'utf8',
        // Only a PATH to find node: no CRON_SECRET from this process can reach the read.
        env: { NODE_ENV: 'test', PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` },
      });

      expect(read).toBe(value);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
