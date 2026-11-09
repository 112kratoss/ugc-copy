import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A post as an agent may read it (`get_post`, and the checks before `publish_post` and
 * `delete_post`): the caller's own post in any state, or anyone's post while it is live, which is
 * what the post page itself shows. Anything else, a private post of someone else's or one taken
 * down, is answered NOT_FOUND rather than described, as the page answers it.
 */

export type AgentPostState = 'live' | 'private' | 'archived' | 'hidden' | 'removed';

export type AgentPostView = {
  postId: string;
  ownerUserId: string;
  generationId: string | null;
  title: string | null;
  description: string | null;
  body: string | null;
  category: string | null;
  visibility: 'public' | 'private';
  state: AgentPostState;
  isNsfw: boolean;
  remixesAllowed: boolean;
  counts: { saves: number; comments: number; remixes: number; shares: number };
  createdAt: string | null;
  isOwn: boolean;
};

export type AgentPostReadResult =
  | { ok: true; post: AgentPostView }
  | { ok: false; code: 'NOT_FOUND' | 'UNAVAILABLE' };

type PostRow = {
  id: string;
  user_id: string;
  generation_id: string | null;
  title: string | null;
  description: string | null;
  body: string | null;
  category: string | null;
  visibility: string | null;
  review_status: string | null;
  archived_at: string | null;
  tombstoned_at: string | null;
  is_nsfw: boolean | null;
  remixes_allowed: boolean | null;
  save_count: number | null;
  comment_count: number | null;
  remix_count: number | null;
  share_count: number | null;
  created_at: string | null;
};

const POST_SELECT = 'id, user_id, generation_id, title, description, body, category, visibility, review_status, archived_at, tombstoned_at, is_nsfw, remixes_allowed, save_count, comment_count, remix_count, share_count, created_at';

/** The state the post page's own rules give a row: removed, then archived, then hidden, then its visibility. */
export function agentPostState(row: Pick<PostRow, 'visibility' | 'review_status' | 'archived_at' | 'tombstoned_at'>): AgentPostState {
  if (row.tombstoned_at) return 'removed';
  if (row.archived_at) return 'archived';
  if (row.review_status && row.review_status !== 'visible') return 'hidden';
  return row.visibility === 'public' ? 'live' : 'private';
}

function count(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function toAgentPostView(row: PostRow, viewerUserId: string): AgentPostView {
  return {
    postId: row.id,
    ownerUserId: row.user_id,
    generationId: row.generation_id,
    title: row.title,
    description: row.description,
    body: row.body,
    category: row.category,
    visibility: row.visibility === 'public' ? 'public' : 'private',
    state: agentPostState(row),
    isNsfw: row.is_nsfw === true,
    remixesAllowed: row.remixes_allowed !== false,
    counts: {
      saves: count(row.save_count),
      comments: count(row.comment_count),
      remixes: count(row.remix_count),
      shares: count(row.share_count),
    },
    createdAt: row.created_at,
    isOwn: row.user_id === viewerUserId,
  };
}

/**
 * Reads one post for an agent. The service client reads it (the authenticated Data API shows a
 * viewer only live posts), and this decides what the agent may see of it.
 */
export async function readPostForAgent(
  admin: SupabaseClient,
  { postId, viewerUserId }: { postId: string; viewerUserId: string },
): Promise<AgentPostReadResult> {
  const { data, error } = await admin.from('posts').select(POST_SELECT).eq('id', postId).maybeSingle();
  if (error) return { ok: false, code: 'UNAVAILABLE' };
  if (!data) return { ok: false, code: 'NOT_FOUND' };
  const post = toAgentPostView(data as PostRow, viewerUserId);
  if (!post.isOwn && post.state !== 'live') return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, post };
}
