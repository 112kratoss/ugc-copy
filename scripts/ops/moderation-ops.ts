import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  listAgentPublishedPostsForModeration,
  listOpenModerationReports,
  resolvePostReport,
  resolveSubjectReport,
  type ModerationQueueSource,
  type PostReportResolution,
} from '../../src/lib/moderation-ops';

/**
 * The app route that refreshes the feed's cached pages
 * (`SHOWCASE_FEED_INVALIDATE_ROUTE`; this script loads under plain tsx, so it
 * cannot import that server-only module, and a test holds the two equal).
 */
export const SHOWCASE_FEED_INVALIDATE_PATH = '/api/cron/showcase-feed-invalidate';
/** The site's address when NEXT_PUBLIC_SITE_URL is not given, as in src/lib/seo.ts. */
const DEFAULT_SITE_URL = 'https://magicbooklet.com';
const FEED_REFRESH_TIMEOUT_MS = 10_000;

export type ModerationOpsDependencies = {
  fetch?: typeof fetch;
  /** Where notes for the operator go: stderr, so the JSON on stdout stays parseable. */
  note?: (message: string) => void;
};

function writeNote(message: string) {
  process.stderr.write(`${message}\n`);
}

/**
 * The refresh to run by hand, from the ugc-app folder. It reads CRON_SECRET as
 * this CLI does, the shell's first and then `.env.local`'s, through Node's own
 * env-file parser, quoted values included, so the secret is never typed,
 * printed or left in the shell's history.
 */
export function manualFeedRefreshCommand(origin: string): string {
  return `curl -fsS -H "Authorization: Bearer $(node --env-file-if-exists=.env.local -p 'process.env.CRON_SECRET')" ${origin}${SHOWCASE_FEED_INVALIDATE_PATH}`;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** Whether a refresh reaches the public site: over https, and not on this machine. */
function isPublicSite(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !LOCAL_HOSTNAMES.has(hostname) && !hostname.endsWith('.localhost');
}

type FeedRefreshAttempt = { refreshed: true; origin: string } | { refreshed: false; reason: string };

async function attemptFeedRefresh(
  endpoint: URL | null,
  { siteUrl, secret }: { siteUrl: string | null; secret: string | null },
  dependencies: ModerationOpsDependencies,
): Promise<FeedRefreshAttempt> {
  if (!secret) return { refreshed: false, reason: 'CRON_SECRET is not set' };
  if (!siteUrl) return { refreshed: false, reason: 'NEXT_PUBLIC_SITE_URL is not set' };
  if (!endpoint) return { refreshed: false, reason: 'NEXT_PUBLIC_SITE_URL is not a URL' };
  try {
    const response = await (dependencies.fetch ?? fetch)(endpoint, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(FEED_REFRESH_TIMEOUT_MS),
    });
    return response.ok
      ? { refreshed: true, origin: endpoint.origin }
      : { refreshed: false, reason: `${endpoint.origin} answered ${response.status}` };
  } catch (error) {
    return {
      refreshed: false,
      reason: `the request to ${endpoint.origin} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Asks the app to refresh the feed's cached pages after a decision changed
 * what they show. The CLI runs outside the app, where `next/cache` does not
 * exist, so without this a taken-down post stayed on the signed-out home page
 * until its window (15 minutes) ran out; its first card's poster is inlined
 * into that page, so deleting the stored files does not hide it either. Never
 * throws. Without the address or the secret, or when the request fails, it
 * says so and gives the command to run, and it warns when the address is not
 * the public site: a run against the production database with a local address
 * would otherwise refresh only that server's pages and look done.
 */
export async function requestShowcaseFeedRefresh(
  environment: NodeJS.ProcessEnv,
  dependencies: ModerationOpsDependencies = {},
): Promise<boolean> {
  const note = dependencies.note ?? writeNote;
  const siteUrl = environment.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || null;
  const secret = environment.CRON_SECRET?.trim() || null;
  let endpoint: URL | null = null;
  if (siteUrl) {
    try {
      endpoint = new URL(SHOWCASE_FEED_INVALIDATE_PATH, `${siteUrl}/`);
    } catch {
      endpoint = null;
    }
  }

  const attempt = await attemptFeedRefresh(endpoint, { siteUrl, secret }, dependencies);
  if (attempt.refreshed) {
    note(`Refreshed the feed's cached pages at ${attempt.origin}.`);
  } else {
    note([
      `Warning: the feed's cached pages were not refreshed (${attempt.reason}).`,
      'The signed-out home page can show the post as it was for up to 15 minutes. Refresh them now, from the ugc-app folder, with:',
      `  ${manualFeedRefreshCommand(endpoint?.origin ?? DEFAULT_SITE_URL)}`,
    ].join('\n'));
  }

  if (endpoint && !isPublicSite(endpoint)) {
    note([
      `Warning: NEXT_PUBLIC_SITE_URL is ${endpoint.origin}, not the public site, so the public site's cached pages were not asked to refresh.`,
      'If this decision was made on the production database, refresh them, from the ugc-app folder, with:',
      `  ${manualFeedRefreshCommand(DEFAULT_SITE_URL)}`,
    ].join('\n'));
  }

  return attempt.refreshed;
}

/**
 * Whether a post decision changes what a cached feed page shows. A take-down
 * hides the post; a rerun of one refreshes again, as it sweeps the media
 * again. A dismissal returns a flagged post to the feed once its last open
 * report is closed, and the resolver does not say whether this one did.
 */
function changesWhatTheFeedShows(result: PostReportResolution): boolean {
  return result.status === 'taken_down'
    || result.status === 'dismissed'
    || (result.status === 'already_resolved' && result.resolutionAction === 'take_down');
}

const USAGE = `
Magicbooklet moderation operations (service role only)

Usage:
  npm run ops:moderation -- list [--limit 50] [--source agent] [--json]
  npm run ops:moderation -- take-down-post --report-id <uuid> --reviewer-id <uuid> --confirm [--note "..."]
  npm run ops:moderation -- dismiss-post --report-id <uuid> --reviewer-id <uuid> --confirm [--note "..."]
  npm run ops:moderation -- resolve-subject --report-id <uuid> --reviewer-id <uuid> --confirm
  npm run ops:moderation -- dismiss-subject --report-id <uuid> --reviewer-id <uuid> --confirm

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
  NEXT_PUBLIC_SITE_URL and CRON_SECRET, to refresh the feed's cached pages after a
    post decision (without them the command prints the request to make by hand)

Notes:
  - Apply all pending Supabase migrations before using mutation commands.
  - --source agent lists the posts AI agents published through the MCP server (from the
    agent_tool_calls audit table, newest first, with each post's state) and narrows the open
    post reports to those posts; subject reports are left out of that view. Take one down with
    take-down-post on its report, as for any post.
  - reviewer-id must identify the staff member's real auth.users row.
  - Resolving a comment report atomically removes the comment and resolves duplicate reports.
  - Resolving a template report takes the template down (it leaves the catalog, its page answers
    not found, no new run starts) and holds it: the creator cannot publish it again until the
    hold is cleared by SQL. Duplicate reports are resolved too; the template's name, slug and
    status are in the list table.
  - Resolve a user/generation report only after completing the required manual safety action.
`.trim();

type ParsedArguments = {
  command: string | null;
  flags: Map<string, string | true>;
};

function parseArguments(args: string[]): ParsedArguments {
  const [command = null, ...tokens] = args;
  const flags = new Map<string, string | true>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    if (token === '--json' || token === '--confirm' || token === '--help') {
      flags.set(token, true);
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}.`);
    }
    flags.set(token, value);
    index += 1;
  }

  return { command, flags };
}

function requireFlag(flags: Map<string, string | true>, name: string) {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requireConfirmation(flags: Map<string, string | true>) {
  if (flags.get('--confirm') !== true) {
    throw new Error('Mutation refused. Review the report, then repeat with --confirm.');
  }
}

function optionalLimit(flags: Map<string, string | true>) {
  const raw = flags.get('--limit');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error('--limit must be a positive integer.');
  }
  return Number(raw);
}

function optionalSource(flags: Map<string, string | true>): ModerationQueueSource | undefined {
  const raw = flags.get('--source');
  if (raw === undefined) return undefined;
  if (raw !== 'agent') {
    throw new Error('--source takes agent (posts published by AI agents through the MCP server).');
  }
  return raw;
}

function summarizeDetails(value: string | null) {
  if (!value) return '';
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

function printAgentPosts(posts: Awaited<ReturnType<typeof listAgentPublishedPostsForModeration>>) {
  console.log(`Posts published by agents: ${posts.length}`);
  if (posts.length > 0) {
    console.table(posts.map((item) => ({
      post_id: item.postId,
      client_id: item.clientId,
      user_id: item.userId,
      published_at: item.publishedAt,
      post_status: item.post ? item.post.reviewStatus : 'deleted',
      visibility: item.post?.visibility ?? '',
      report_count: item.post?.reportCount ?? '',
      post_title: item.post?.title ?? '',
    })));
  }
}

function printQueue(snapshot: Awaited<ReturnType<typeof listOpenModerationReports>>) {
  console.log(`Open post reports: ${snapshot.postReports.length}`);
  if (snapshot.postReports.length > 0) {
    console.table(snapshot.postReports.map((report) => ({
      report_id: report.id,
      post_id: report.postId,
      reason: report.reason,
      details: summarizeDetails(report.details),
      post_status: report.post?.reviewStatus ?? 'missing',
      post_title: report.post?.title ?? '',
      created_at: report.createdAt,
    })));
  }

  console.log(`Open/reviewing subject reports: ${snapshot.subjectReports.length}`);
  if (snapshot.subjectReports.length > 0) {
    console.table(snapshot.subjectReports.map((report) => ({
      report_id: report.id,
      target_type: report.targetType,
      target_id: report.reportedUserId ?? report.generationId ?? report.commentId ?? report.templateId,
      template_name: report.template?.name ?? '',
      template_slug: report.template?.slug ?? '',
      template_status: report.template?.status ?? '',
      comment_post_id: report.comment?.postId ?? '',
      comment_status: report.comment?.status ?? '',
      comment_body: summarizeDetails(report.comment?.body ?? null),
      reason: report.reason,
      details: summarizeDetails(report.details),
      status: report.status,
      created_at: report.createdAt,
    })));
  }
}

export async function runModerationOps(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ModerationOpsDependencies = {},
) {
  const { command, flags } = parseArguments(args);
  if (!command || command === 'help' || command === '--help' || flags.has('--help')) {
    console.log(USAGE);
    return;
  }

  const supabaseUrl = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  if (command === 'list') {
    const limit = optionalLimit(flags);
    const source = optionalSource(flags);
    const snapshot = await listOpenModerationReports(supabase, { limit, ...(source ? { source } : {}) });
    // The agent view lists what agents published first, reported or not, then the reports of it.
    const agentPosts = source === 'agent' ? await listAgentPublishedPostsForModeration(supabase, { limit }) : null;
    if (flags.get('--json') === true) {
      console.log(JSON.stringify(agentPosts ? { agentPosts, ...snapshot } : snapshot, null, 2));
    } else {
      if (agentPosts) printAgentPosts(agentPosts);
      printQueue(snapshot);
    }
    return;
  }

  requireConfirmation(flags);
  const reportId = requireFlag(flags, '--report-id');
  const reviewerId = requireFlag(flags, '--reviewer-id');

  if (command === 'take-down-post' || command === 'dismiss-post') {
    let result: PostReportResolution;
    try {
      result = await resolvePostReport(supabase, {
        reportId,
        reviewerId,
        action: command === 'take-down-post' ? 'take_down' : 'dismiss',
        resolutionNote: typeof flags.get('--note') === 'string' ? flags.get('--note') as string : null,
      });
    } catch (error) {
      // The decision commits before the work that can fail after it: a
      // take-down's media cleanup runs after the commit, and refuses the same
      // way on every rerun for media outside the post's scope. The post may be
      // hidden (or back) already, so the cached pages are refreshed before the
      // error goes on, exit code and all.
      (dependencies.note ?? writeNote)(
        'The decision may have been recorded before this failure: refreshing the feed\'s cached pages in case it was.',
      );
      await requestShowcaseFeedRefresh(environment, dependencies);
      throw error;
    }
    console.log(JSON.stringify(result, null, 2));
    if (changesWhatTheFeedShows(result)) {
      await requestShowcaseFeedRefresh(environment, dependencies);
    }
    return;
  }

  if (command === 'resolve-subject' || command === 'dismiss-subject') {
    const result = await resolveSubjectReport(supabase, {
      reportId,
      reviewerId,
      action: command === 'resolve-subject' ? 'resolve' : 'dismiss',
      // Now mandatory, matching take-down-post. The resolver rejects a decision
      // that would leave no rationale in the audit record.
      resolutionNote: requireFlag(flags, '--note'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runModerationOps(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
