import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { runPagedQuery } from '@/lib/admin-paged-query';

/**
 * Read models for the admin Content area: published posts and the generation
 * pipeline behind them. Generation failures are surfaced separately because a
 * spike in `status = 'failed'` is usually a provider incident rather than a
 * content problem, and the two need different responses.
 */

const MAX_LIMIT = 100;

export type AdminPostRow = {
  id: string;
  userId: string;
  title: string | null;
  visibility: string;
  reviewStatus: string;
  postFormat: string | null;
  category: string | null;
  reportCount: number;
  saveCount: number;
  commentCount: number;
  createdAt: string;
};

export type AdminGenerationRow = {
  id: string;
  userId: string;
  status: string;
  model: string | null;
  cost: number | null;
  creationMode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type AdminContentSnapshot = {
  posts: AdminPostRow[];
  generations: AdminGenerationRow[];
  totals: {
    posts: number;
    hiddenPosts: number;
    generations24h: number;
    failedGenerations24h: number;
  };
  /**
   * Row counts for the *filtered* lists, which is what a pager needs.
   * `totals.posts` counts every post regardless of filter, so paging off it
   * would offer pages that the active filter has no rows for.
   */
  pageTotals: {
    posts: number;
    generations: number;
  };
  /** Where each list actually landed; see `runPagedQuery`. */
  pageOffsets: {
    posts: number;
    generations: number;
  };
};

export type AdminPostFilter = 'all' | 'public' | 'hidden' | 'reported';
export type AdminGenerationFilter = 'all' | 'failed' | 'processing';

function normalizeLimit(limit: number | undefined) {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 40;
  return Math.min(limit, MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined) {
  if (!offset || !Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

export async function collectAdminContentSnapshot(
  client: SupabaseClient,
  options: {
    postFilter?: AdminPostFilter;
    generationFilter?: AdminGenerationFilter;
    limit?: number;
    postOffset?: number;
    generationOffset?: number;
    now?: Date;
  } = {},
): Promise<AdminContentSnapshot> {
  const limit = normalizeLimit(options.limit);
  const postOffset = normalizeOffset(options.postOffset);
  const generationOffset = normalizeOffset(options.generationOffset);
  const now = options.now ?? new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const postFilter = options.postFilter ?? 'all';
  const generationFilter = options.generationFilter ?? 'all';

  const buildPostsQuery = (from: number, to: number) => {
    const query = client
      .from('posts')
      .select(
        'id, user_id, title, visibility, review_status, post_format, category, report_count, save_count, comment_count, created_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (postFilter === 'public') return query.eq('visibility', 'public');
    if (postFilter === 'hidden') return query.neq('visibility', 'public');
    if (postFilter === 'reported') return query.gt('report_count', 0);
    return query;
  };

  const buildGenerationsQuery = (from: number, to: number) => {
    const query = client
      .from('generations')
      .select(
        'id, user_id, status, model, cost, creation_mode, error_message, created_at, completed_at',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

    if (generationFilter === 'failed') return query.eq('status', 'failed');
    if (generationFilter === 'processing') {
      return query.in('status', ['pending', 'processing', 'starting']);
    }
    return query;
  };

  const [posts, generations, postsCount, hiddenCount, generations24h, failed24h] = await Promise.all([
    runPagedQuery<Record<string, unknown>>(buildPostsQuery, { offset: postOffset, pageSize: limit }),
    runPagedQuery<Record<string, unknown>>(buildGenerationsQuery, {
      offset: generationOffset,
      pageSize: limit,
    }),
    client.from('posts').select('id', { count: 'exact', head: true }),
    client.from('posts').select('id', { count: 'exact', head: true }).neq('visibility', 'public'),
    client.from('generations').select('id', { count: 'exact', head: true }).gte('created_at', dayAgo),
    client
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', dayAgo),
  ]);

  for (const result of [postsCount, hiddenCount, generations24h, failed24h]) {
    if (result.error) throw result.error;
  }

  return {
    posts: posts.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id ?? ''),
      title: (row.title as string | null) ?? null,
      visibility: String(row.visibility ?? ''),
      reviewStatus: String(row.review_status ?? ''),
      postFormat: (row.post_format as string | null) ?? null,
      category: (row.category as string | null) ?? null,
      reportCount: Number(row.report_count ?? 0),
      saveCount: Number(row.save_count ?? 0),
      commentCount: Number(row.comment_count ?? 0),
      createdAt: String(row.created_at ?? ''),
    })),
    generations: generations.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id ?? ''),
      status: String(row.status ?? ''),
      model: (row.model as string | null) ?? null,
      cost: typeof row.cost === 'number' ? row.cost : null,
      creationMode: (row.creation_mode as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      createdAt: String(row.created_at ?? ''),
      completedAt: (row.completed_at as string | null) ?? null,
    })),
    totals: {
      posts: postsCount.count ?? 0,
      hiddenPosts: hiddenCount.count ?? 0,
      generations24h: generations24h.count ?? 0,
      failedGenerations24h: failed24h.count ?? 0,
    },
    pageTotals: {
      posts: posts.total,
      generations: generations.total,
    },
    pageOffsets: {
      posts: posts.offset,
      generations: generations.offset,
    },
  };
}
