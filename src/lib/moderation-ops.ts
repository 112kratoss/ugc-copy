import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEFAULT_QUEUE_LIMIT = 50;
const MAX_QUEUE_LIMIT = 200;
const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const SHOWCASE_PUBLIC_URL_MARKER = '/storage/v1/object/public/showcase_media/';

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
  targetType: 'user' | 'generation' | 'comment';
  reportedUserId: string | null;
  generationId: string | null;
  commentId: string | null;
  reason: string;
  details: string | null;
  sourceSurface: string;
  status: 'open' | 'reviewing';
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  comment: {
    id: string;
    postId: string;
    parentId: string | null;
    authorUserId: string | null;
    body: string;
    status: string;
  } | null;
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
  revokedMediaCount?: number;
  mediaRevocationVerified?: boolean;
  externalMediaRevocationRequired?: boolean;
};

export type SubjectReportResolution = {
  status: 'resolved' | 'dismissed' | 'already_resolved';
  reportId: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  targetType: 'user' | 'generation' | 'comment';
  commentId: string | null;
  commentStatus: string | null;
  commentRemoved: boolean;
  resolvedReportCount?: number;
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

type PostModerationMediaRow = {
  id: string;
  generation_id: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
};

type PostMediaModerationRow = {
  storage_path: string | null;
  preview_storage_path: string | null;
  external_url: string | null;
};

type SubjectReportRow = {
  id: string;
  reporter_user_id: string | null;
  target_type: 'user' | 'generation' | 'comment';
  reported_user_id: string | null;
  generation_id: string | null;
  comment_id: string | null;
  reason: string;
  details: string | null;
  source_surface: string;
  status: 'open' | 'reviewing' | 'resolved' | 'dismissed';
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

type CommentModerationRow = {
  id: string;
  post_id: string;
  parent_comment_id: string | null;
  user_id: string | null;
  body: string;
  status: string;
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

function normalizeShowcaseMediaPath(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let path = trimmed.replace(/^\/+/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const markerIndex = url.pathname.indexOf(SHOWCASE_PUBLIC_URL_MARKER);
      if (markerIndex < 0) return null;
      path = decodeURIComponent(url.pathname.slice(markerIndex + SHOWCASE_PUBLIC_URL_MARKER.length));
    } catch {
      return null;
    }
  }

  if (path.startsWith(`${SHOWCASE_MEDIA_BUCKET}/`)) {
    path = path.slice(SHOWCASE_MEDIA_BUCKET.length + 1);
  }

  return path && !path.includes('..') && !path.includes('\\') ? path : null;
}

function isOwnedModerationMediaPath(path: string, postId: string, generationId: string | null) {
  return path.startsWith(`posts/${postId}/`)
    || Boolean(generationId && path.startsWith(`showcase/${generationId}/`));
}

async function revokePostPublicMedia(
  supabase: SupabaseClient,
  postId: string,
): Promise<{
  revokedMediaCount: number;
  mediaRevocationVerified: true;
  externalMediaRevocationRequired: boolean;
}> {
  const [postResult, mediaResult] = await Promise.all([
    supabase
      .from('posts')
      .select('id, generation_id, showcase_asset_path, output_url')
      .eq('id', postId)
      .maybeSingle(),
    supabase
      .from('post_media')
      .select('storage_path, preview_storage_path, external_url')
      .eq('post_id', postId),
  ]);

  if (postResult.error) {
    throw databaseError('Failed to load taken-down post media', postResult.error);
  }
  if (mediaResult.error) {
    throw databaseError('Failed to load taken-down post gallery media', mediaResult.error);
  }

  const post = postResult.data as PostModerationMediaRow | null;
  if (!post) {
    throw new Error('Taken-down post could not be loaded for media revocation.');
  }

  const mediaRows = (mediaResult.data ?? []) as PostMediaModerationRow[];
  const rawStorageValues = [
    post.showcase_asset_path,
    post.output_url,
    ...mediaRows.flatMap((row) => [row.storage_path, row.preview_storage_path]),
  ];
  const storagePaths = [...new Set(rawStorageValues
    .map(normalizeShowcaseMediaPath)
    .filter((path): path is string => Boolean(path)))];

  const unsafePaths = storagePaths.filter(
    (path) => !isOwnedModerationMediaPath(path, postId, post.generation_id),
  );
  if (unsafePaths.length > 0) {
    throw new Error('Refusing to revoke a taken-down media path outside the reported post scope.');
  }

  if (storagePaths.length > 0) {
    const removal = await supabase.storage.from(SHOWCASE_MEDIA_BUCKET).remove(storagePaths);
    if (removal.error) {
      throw databaseError('Failed to revoke taken-down public media', removal.error);
    }

    const verification = await Promise.all(
      storagePaths.map((path) => supabase.storage.from(SHOWCASE_MEDIA_BUCKET).exists(path)),
    );
    if (verification.some((result) => result.data === true)) {
      throw new Error('Taken-down public media still exists after Storage revocation.');
    }
  }

  const hasExternalReference = [
    post.output_url,
    ...mediaRows.map((row) => row.external_url),
  ].some((value) => Boolean(
    value?.trim()
    && normalizeShowcaseMediaPath(value) === null,
  ));

  return {
    revokedMediaCount: storagePaths.length,
    mediaRevocationVerified: true,
    externalMediaRevocationRequired: hasExternalReference,
  };
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
      .select('id, reporter_user_id, target_type, reported_user_id, generation_id, comment_id, reason, details, source_surface, status, created_at, updated_at, reviewed_at, reviewed_by')
      .in('status', ['open', 'reviewing'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit),
  ]);

  if (postReportResult.error) {
    throw databaseError('Failed to list open post reports', postReportResult.error);
  }
  if (subjectReportResult.error) {
    throw databaseError('Failed to list open subject reports', subjectReportResult.error);
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

  const subjectReportRows = (subjectReportResult.data ?? []) as SubjectReportRow[];
  const commentIds = [...new Set(subjectReportRows
    .map((row) => row.comment_id)
    .filter((id): id is string => Boolean(id)))];
  let commentsById = new Map<string, CommentModerationRow>();

  if (commentIds.length > 0) {
    const commentResult = await supabase
      .from('post_comments')
      .select('id, post_id, parent_comment_id, user_id, body, status')
      .in('id', commentIds);
    if (commentResult.error) {
      throw databaseError('Failed to hydrate reported comments', commentResult.error);
    }
    commentsById = new Map(
      ((commentResult.data ?? []) as CommentModerationRow[]).map((row) => [row.id, row]),
    );
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
    subjectReports: subjectReportRows.map((row) => {
      const comment = row.comment_id ? commentsById.get(row.comment_id) ?? null : null;
      return {
        id: row.id,
        reporterUserId: row.reporter_user_id,
        targetType: row.target_type,
        reportedUserId: row.reported_user_id,
        generationId: row.generation_id,
        commentId: row.comment_id,
        reason: row.reason,
        details: row.details,
        sourceSurface: row.source_surface,
        status: row.status as 'open' | 'reviewing',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
        comment: comment
          ? {
              id: comment.id,
              postId: comment.post_id,
              parentId: comment.parent_comment_id,
              authorUserId: comment.user_id,
              body: comment.body,
              status: comment.status,
            }
          : null,
      };
    }),
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

  const resolution: PostReportResolution = {
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

  const requiresMediaRevocation = options.action === 'take_down'
    && (
      status === 'taken_down'
      || (status === 'already_resolved' && resolution.resolutionAction === 'take_down')
    );
  if (!requiresMediaRevocation) {
    return resolution;
  }

  const mediaRevocation = await revokePostPublicMedia(supabase, resolution.postId);
  return {
    ...resolution,
    ...mediaRevocation,
  };
}

export async function resolveSubjectReport(
  supabase: SupabaseClient,
  options: {
    reportId: string;
    reviewerId: string;
    action: 'resolve' | 'dismiss';
    /**
     * Mandatory. A status change alone cannot answer an appeal, so the resolver
     * refuses a decision that leaves no rationale behind.
     */
    resolutionNote: string;
  },
): Promise<SubjectReportResolution> {
  const reportId = requireUuid(options.reportId, 'Report id');
  const reviewerId = requireUuid(options.reviewerId, 'Reviewer id');
  const resolutionNote = options.resolutionNote?.trim() ?? '';
  if (resolutionNote.length < 3 || resolutionNote.length > 1000) {
    throw new Error('A resolution note of 3 to 1000 characters is required.');
  }

  const { data, error } = await supabase.rpc('resolve_subject_report_for_ops', {
    p_report_id: reportId,
    p_reviewer_id: reviewerId,
    p_action: options.action,
    p_resolution_note: resolutionNote,
  });
  if (error) {
    throw databaseError('Failed to resolve subject report', error);
  }

  const result = asRecord(data);
  const status = result.status;
  if (status !== 'resolved' && status !== 'dismissed' && status !== 'already_resolved') {
    throw new Error('Subject report resolver returned an invalid response.');
  }

  const targetType = result.target_type;
  if (targetType !== 'user' && targetType !== 'generation' && targetType !== 'comment') {
    throw new Error('Subject report resolver returned an invalid target type.');
  }

  return {
    status,
    reportId: String(result.report_id ?? reportId),
    reviewedAt: typeof result.reviewed_at === 'string' ? result.reviewed_at : null,
    reviewedBy: typeof result.reviewed_by === 'string' ? result.reviewed_by : null,
    targetType,
    commentId: typeof result.comment_id === 'string' ? result.comment_id : null,
    commentStatus: typeof result.comment_status === 'string' ? result.comment_status : null,
    commentRemoved: result.comment_removed === true,
    resolvedReportCount: typeof result.resolved_report_count === 'number'
      ? result.resolved_report_count
      : undefined,
  };
}
