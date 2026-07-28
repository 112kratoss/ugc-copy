import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

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
};

export type AdminPostFilter = 'all' | 'public' | 'hidden' | 'reported';
export type AdminGenerationFilter = 'all' | 'failed' | 'processing';

function normalizeLimit(limit: number | undefined) {
  if (!limit || !Number.isInteger(limit) || limit < 1) return 40;
  return Math.min(limit, MAX_LIMIT);
}

export async function collectAdminContentSnapshot(
  client: SupabaseClient,
  options: {
    postFilter?: AdminPostFilter;
    generationFilter?: AdminGenerationFilter;
    limit?: number;
    now?: Date;
  } = {},
): Promise<AdminContentSnapshot> {
  const limit = normalizeLimit(options.limit);
  const now = options.now ?? new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  let postsQuery = client
    .from('posts')
    .select('id, user_id, title, visibility, review_status, post_format, category, report_count, save_count, comment_count, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  const postFilter = options.postFilter ?? 'all';
  if (postFilter === 'public') {
    postsQuery = postsQuery.eq('visibility', 'public');
  } else if (postFilter === 'hidden') {
    postsQuery = postsQuery.neq('visibility', 'public');
  } else if (postFilter === 'reported') {
    postsQuery = postsQuery.gt('report_count', 0);
  }

  let generationsQuery = client
    .from('generations')
    .select('id, user_id, status, model, cost, creation_mode, error_message, created_at, completed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  const generationFilter = options.generationFilter ?? 'all';
  if (generationFilter === 'failed') {
    generationsQuery = generationsQuery.eq('status', 'failed');
  } else if (generationFilter === 'processing') {
    generationsQuery = generationsQuery.in('status', ['pending', 'processing', 'starting']);
  }

  const [posts, generations, postsCount, hiddenCount, generations24h, failed24h] = await Promise.all([
    postsQuery,
    generationsQuery,
    client.from('posts').select('id', { count: 'exact', head: true }),
    client.from('posts').select('id', { count: 'exact', head: true }).neq('visibility', 'public'),
    client.from('generations').select('id', { count: 'exact', head: true }).gte('created_at', dayAgo),
    client
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', dayAgo),
  ]);

  for (const result of [posts, generations, postsCount, hiddenCount, generations24h, failed24h]) {
    if (result.error) throw result.error;
  }

  return {
    posts: ((posts.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
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
    generations: ((generations.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
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
  };
}
