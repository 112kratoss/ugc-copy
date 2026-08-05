import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  listOpenModerationReports,
  resolvePostReport,
  resolveSubjectReport,
  type ModerationQueueSnapshot,
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
