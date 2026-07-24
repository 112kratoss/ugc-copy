import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEFAULT_QUEUE_LIMIT = 50;
const MAX_QUEUE_LIMIT = 200;

export type PostModerationQueueItem = {
  id: string;
  postId: string;
  bundleId: string | null;
  reporterUserId: string | null;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  post: {
    id: string;
    userId: string;
    title: string | null;
    visibility: string;
    reviewStatus: string;
    reportCount: number;
    createdAt: string;
  } | null;
};

export type SubjectModerationQueueItem = {
  id: string;
  reporterUserId: string | null;
  targetType: 'user' | 'generation';
  reportedUserId: string | null;
  generationId: string | null;
  reason: string;
  details: string | null;
  sourceSurface: string;
  status: 'open' | 'reviewing';
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

export type ModerationQueueSnapshot = {
  postReports: PostModerationQueueItem[];
  subjectReports: SubjectModerationQueueItem[];
};

export type PostReportResolution = {
  status: 'taken_down' | 'dismissed' | 'already_resolved';
  reportId: string;
  postId: string;
  reportStatus: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  resolutionAction?: string | null;
  postReviewStatus?: string;
  resolvedReportCount?: number;
};

export type SubjectReportResolution = {
  status: 'resolved' | 'dismissed' | 'already_resolved';
  reportId: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

type PostReportRow = {
  id: string;
  post_id: string;
  bundle_id: string | null;
  reporter_user_id: string | null;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type PostRow = {
  id: string;
  user_id: string;
  title: string | null;
  visibility: string;
  review_status: string;
  report_count: number;
  created_at: string;
};

type SubjectReportRow = {
  id: string;
  reporter_user_id: string | null;
  target_type: 'user' | 'generation';
  reported_user_id: string | null;
  generation_id: string | null;
  reason: string;
  details: string | null;
  source_surface: string;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireUuid(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must be a UUID.`);
  }
  return normalized;
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_QUEUE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUEUE_LIMIT) {
    throw new Error(`Queue limit must be an integer from 1 to ${MAX_QUEUE_LIMIT}.`);
  }
  return value;
}

function databaseError(operation: string, error: unknown) {
  const candidate = asRecord(error);
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown database error';
  return new Error(`${operation}: ${message}`);
}

export async function listOpenModerationReports(
  supabase: SupabaseClient,
  options: { limit?: number } = {},
): Promise<ModerationQueueSnapshot> {
  const limit = normalizeLimit(options.limit);
  const [postReportResult, subjectReportResult] = await Promise.all([
    supabase
      .from('post_reports')
      .select('id, post_id, bundle_id, reporter_user_id, reason, details, status, created_at, updated_at')
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit),
    supabase
      .from('moderation_reports')
      .select('id, reporter_user_id, target_type, reported_user_id, generation_id, reason, details, source_surface, status, created_at, updated_at, reviewed_at, reviewed_by')
      .in('status', ['open', 'reviewing'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit),
  ]);

  if (postReportResult.error) {
    throw databaseError('Failed to list open post reports', postReportResult.error);
  }
  if (subjectReportResult.error) {
    throw databaseError('Failed to list open user and generation reports', subjectReportResult.error);
  }

  const postReportRows = (postReportResult.data ?? []) as PostReportRow[];
  const postIds = [...new Set(postReportRows.map((row) => row.post_id))];
  let postsById = new Map<string, PostRow>();

  if (postIds.length > 0) {
    const postResult = await supabase
      .from('posts')
      .select('id, user_id, title, visibility, review_status, report_count, created_at')
      .in('id', postIds);
    if (postResult.error) {
      throw databaseError('Failed to hydrate reported posts', postResult.error);
    }
    postsById = new Map(((postResult.data ?? []) as PostRow[]).map((row) => [row.id, row]));
  }

  return {
    postReports: postReportRows.map((row) => {
      const post = postsById.get(row.post_id) ?? null;
      return {
        id: row.id,
        postId: row.post_id,
        bundleId: row.bundle_id,
        reporterUserId: row.reporter_user_id,
        reason: row.reason,
        details: row.details,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        post: post
          ? {
              id: post.id,
              userId: post.user_id,
              title: post.title,
              visibility: post.visibility,
              reviewStatus: post.review_status,
              reportCount: post.report_count,
              createdAt: post.created_at,
            }
          : null,
      };
    }),
    subjectReports: ((subjectReportResult.data ?? []) as SubjectReportRow[]).map((row) => ({
      id: row.id,
      reporterUserId: row.reporter_user_id,
      targetType: row.target_type,
      reportedUserId: row.reported_user_id,
      generationId: row.generation_id,
      reason: row.reason,
      details: row.details,
      sourceSurface: row.source_surface,
      status: row.status as 'open' | 'reviewing',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
    })),
  };
}

export async function resolvePostReport(
  supabase: SupabaseClient,
  options: {
    reportId: string;
    reviewerId: string;
    action: 'take_down' | 'dismiss';
    resolutionNote?: string | null;
  },
): Promise<PostReportResolution> {
  const reportId = requireUuid(options.reportId, 'Report id');
  const reviewerId = requireUuid(options.reviewerId, 'Reviewer id');
  const resolutionNote = options.resolutionNote?.trim() || null;
  if (resolutionNote && resolutionNote.length > 1000) {
    throw new Error('Resolution note must be 1000 characters or fewer.');
  }

  const { data, error } = await supabase.rpc('resolve_post_report_for_ops', {
    p_report_id: reportId,
    p_reviewer_id: reviewerId,
    p_action: options.action,
    p_resolution_note: resolutionNote,
  });
  if (error) {
    throw databaseError('Failed to resolve post report', error);
  }

  const result = asRecord(data);
  const status = result.status;
  if (status !== 'taken_down' && status !== 'dismissed' && status !== 'already_resolved') {
    throw new Error('Post report resolver returned an invalid response.');
  }

  return {
    status,
    reportId: String(result.report_id ?? reportId),
    postId: String(result.post_id ?? ''),
    reportStatus: String(result.report_status ?? ''),
    reviewedAt: typeof result.reviewed_at === 'string' ? result.reviewed_at : null,
    reviewedBy: typeof result.reviewed_by === 'string' ? result.reviewed_by : null,
    resolutionAction: typeof result.resolution_action === 'string' ? result.resolution_action : null,
    postReviewStatus: typeof result.post_review_status === 'string' ? result.post_review_status : undefined,
    resolvedReportCount: typeof result.resolved_report_count === 'number'
      ? result.resolved_report_count
      : undefined,
  };
}

export async function resolveSubjectReport(
  supabase: SupabaseClient,
  options: {
    reportId: string;
    reviewerId: string;
    action: 'resolve' | 'dismiss';
    now?: Date;
  },
): Promise<SubjectReportResolution> {
  const reportId = requireUuid(options.reportId, 'Report id');
  const reviewerId = requireUuid(options.reviewerId, 'Reviewer id');
  const reviewedAt = (options.now ?? new Date()).toISOString();
  const nextStatus = options.action === 'resolve' ? 'resolved' : 'dismissed';
  const columns = 'id, status, reviewed_at, reviewed_by';

  const { data, error } = await supabase
    .from('moderation_reports')
    .update({
      status: nextStatus,
      reviewed_at: reviewedAt,
      reviewed_by: reviewerId,
    })
    .eq('id', reportId)
    .in('status', ['open', 'reviewing'])
    .select(columns)
    .maybeSingle();
  if (error) {
    throw databaseError('Failed to resolve user or generation report', error);
  }

  if (data) {
    const row = data as Pick<SubjectReportRow, 'id' | 'status' | 'reviewed_at' | 'reviewed_by'>;
    return {
      status: row.status as 'resolved' | 'dismissed',
      reportId: row.id,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by,
    };
  }

  const current = await supabase
    .from('moderation_reports')
    .select(columns)
    .eq('id', reportId)
    .maybeSingle();
  if (current.error) {
    throw databaseError('Failed to inspect user or generation report', current.error);
  }
  if (!current.data) {
    throw new Error('Moderation report not found.');
  }

  const currentRow = current.data as Pick<SubjectReportRow, 'id' | 'reviewed_at' | 'reviewed_by'>;
  return {
    status: 'already_resolved',
    reportId: currentRow.id,
    reviewedAt: currentRow.reviewed_at,
    reviewedBy: currentRow.reviewed_by,
  };
}
