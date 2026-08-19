import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  applyPostModerationAction,
  listOpenModerationReports,
  listResolvedModerationReports,
  resolvePostReport,
  resolveSubjectReport,
  type ModerationHistorySnapshot,
  type ModerationQueueSnapshot,
  type PostModerationAction,
  type PostModerationActionResult,
  type PostReportResolution,
  type SubjectReportResolution,
} from '@/lib/moderation-ops';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

/**
 * Admin console wrapper over the existing moderation ops core.
 *
 * The console and `npm run ops:moderation` deliberately share
 * `moderation-ops.ts`: take-down remains one transactional RPC plus verified
 * storage revocation regardless of which front-end triggered it. The only thing
 * this layer adds is that the reviewer id comes from the authenticated session
 * rather than a hand-typed `--reviewer-id` flag.
 */

export type AdminModerationQueue = ModerationQueueSnapshot & {
  openCount: number;
  oldestOpenAt: string | null;
};

export async function countOpenModerationReports(client: SupabaseClient): Promise<number> {
  const [postReports, subjectReports] = await Promise.all([
    client.from('post_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    client
      .from('moderation_reports')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'reviewing']),
  ]);

  if (postReports.error) throw postReports.error;
  if (subjectReports.error) throw subjectReports.error;

  return (postReports.count ?? 0) + (subjectReports.count ?? 0);
}

export async function collectAdminModerationQueue(
  client: SupabaseClient,
  options: { limit?: number } = {},
): Promise<AdminModerationQueue> {
  const snapshot = await listOpenModerationReports(client, { limit: options.limit ?? 100 });

  const createdTimestamps = [
    ...snapshot.postReports.map((report) => report.createdAt),
    ...snapshot.subjectReports.map((report) => report.createdAt),
  ].filter(Boolean).sort();

  return {
    ...snapshot,
    openCount: snapshot.postReports.length + snapshot.subjectReports.length,
    oldestOpenAt: createdTimestamps[0] ?? null,
  };
}

export const ADMIN_MODERATION_HISTORY_PAGE_SIZE = 25;

/** A resolved report plus the operator name behind the reviewer id. */
export type AdminModerationHistory = ModerationHistorySnapshot & {
  reviewers: Record<string, { username: string | null; displayName: string | null }>;
  pageSize: number;
  /**
   * Separate offsets because the two families are separate tables with very
   * different volumes: a shared cursor would page a short list past its end
   * whenever the operator advanced the long one.
   */
  postOffset: number;
  subjectOffset: number;
};

/**
 * Reviewer ids are `auth.users` ids, which mean nothing on screen. Resolving
 * them through `profiles` keeps the id as the durable record while giving the
 * operator a name to read. A reviewer with no profile row degrades to the bare
 * id rather than dropping the decision from the history.
 */
async function hydrateReviewerNames(
  client: SupabaseClient,
  reviewerIds: string[],
): Promise<AdminModerationHistory['reviewers']> {
  const uniqueIds = [...new Set(reviewerIds)];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await client
    .from('profiles')
    .select('id, username, display_name')
    .in('id', uniqueIds);
  if (error) throw error;

  const reviewers: AdminModerationHistory['reviewers'] = {};
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    reviewers[String(row.id)] = {
      username: (row.username as string | null) ?? null,
      displayName: (row.display_name as string | null) ?? null,
    };
  }
  return reviewers;
}

export async function collectAdminModerationHistory(
  client: SupabaseClient,
  options: { postOffset?: number; subjectOffset?: number; pageSize?: number } = {},
): Promise<AdminModerationHistory> {
  const pageSize = options.pageSize ?? ADMIN_MODERATION_HISTORY_PAGE_SIZE;
  const postOffset = options.postOffset ?? 0;
  const subjectOffset = options.subjectOffset ?? 0;

  const snapshot = await listResolvedModerationReports(client, {
    limit: pageSize,
    postOffset,
    subjectOffset,
  });

  const reviewerIds = [
    ...snapshot.postReports.map((report) => report.reviewedBy),
    ...snapshot.subjectReports.map((report) => report.reviewedBy),
  ].filter((id): id is string => Boolean(id));

  return {
    ...snapshot,
    reviewers: await hydrateReviewerNames(client, reviewerIds),
    pageSize,
    // The snapshot's offsets, not the requested ones: a request past the end
    // falls back to the first page and the pager must say so.
    postOffset: snapshot.offsets.postReports,
    subjectOffset: snapshot.offsets.subjectReports,
  };
}

export async function applyAdminPostReportDecision(
  client: SupabaseClient,
  options: {
    reportId: string;
    reviewerId: string;
    action: 'take_down' | 'dismiss';
    resolutionNote: string;
  },
): Promise<PostReportResolution> {
  // A rationale is mandatory in the console even though the RPC accepts null:
  // the audit record is the only durable explanation of why content was
  // removed, and an empty note makes an appeal impossible to answer.
  const note = options.resolutionNote.trim();
  if (!note) {
    throw new Error('A resolution note is required.');
  }

  const resolution = await resolvePostReport(client, {
    reportId: options.reportId,
    reviewerId: options.reviewerId,
    action: options.action,
    resolutionNote: note,
  });

  // Hiding the post is not enough on its own: cached feed pages keep serving it
  // until their tag is revalidated. This lives here rather than in
  // moderation-ops.ts because that module is also driven by the tsx ops CLI,
  // where next/cache does not exist -- a CLI take-down stays bounded by the
  // feed's own 60s revalidate instead.
  //
  // The predicate matches the one moderation-ops uses to decide media
  // revocation, so a retried take-down re-invalidates just as it re-sweeps.
  const tookDownPost = resolution.status === 'taken_down'
    || (resolution.status === 'already_resolved' && resolution.resolutionAction === 'take_down');
  if (tookDownPost) {
    invalidateShowcaseFeedCache();
  }

  return resolution;
}

export async function applyAdminSubjectReportDecision(
  client: SupabaseClient,
  options: {
    reportId: string;
    reviewerId: string;
    action: 'resolve' | 'dismiss';
    resolutionNote: string;
  },
): Promise<SubjectReportResolution> {
  // Same standard the post-report path already enforces: the audit record is
  // the only durable explanation of why a decision was made.
  const note = options.resolutionNote.trim();
  if (!note) {
    throw new Error('A resolution note is required.');
  }

  return resolveSubjectReport(client, { ...options, resolutionNote: note });
}


/**
 * Proactive post moderation — no report required.
 *
 * The feed cache invalidation matters on every action, not just removals: a
 * restored post stays absent from cached pages until its tag is revalidated,
 * so an operator undoing a mistake would otherwise watch nothing happen for up
 * to the feed's revalidate window and reasonably conclude the tool is broken.
 *
 * As with the report path this lives here rather than in `moderation-ops.ts`,
 * which is also driven by the tsx ops CLI where `next/cache` does not exist.
 */
export async function applyAdminPostModeration(
  client: SupabaseClient,
  options: {
    postId: string;
    reviewerId: string;
    action: PostModerationAction;
    reason: string;
    idempotencyKey: string;
  },
): Promise<PostModerationActionResult> {
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error('A reason is required.');
  }

  const result = await applyPostModerationAction(client, { ...options, reason });

  if (result.status === 'applied' || result.status === 'already_applied') {
    invalidateShowcaseFeedCache();
  }

  return result;
}
