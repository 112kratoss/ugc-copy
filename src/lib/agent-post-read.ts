import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A post as an agent may read it (`get_post`, and the checks before `publish_post` and
 * `delete_post`): the caller's own post in any state, or anyone's post while it is live, which is
 * what the post page itself shows. Anything else, a private post of someone else's or one taken
 * down, is answered NOT_FOUND rather than described, as the page answers it.
 */

export type AgentPostState = 'live' | 'private' | 'archived' | 'hidden' | 'removed';

/**
 * What a post offers beside itself, as three facts and nothing else: whether it carries a
 * resource (a creation's recipe, or the prompts, guides and links of a composed post), its price
 * in tokens, and whether it is on offer. Never what the resource holds: that is read only through
 * the paywall (`hydrateBundleRows` in `post-resource-bundles-server.ts`), which no agent tool calls.
 */
export type AgentPostResource = {
  access: 'none' | 'free' | 'paid';
  /** The price in tokens (100 tokens = $1.00); 0 for none and for free. */
  priceTokens: number;
  /** `published` while on offer, `draft` while its post is not public; null for none. */
  status: 'draft' | 'published' | null;
};

export const AGENT_POST_NO_RESOURCE: AgentPostResource = { access: 'none', priceTokens: 0, status: null };

export type AgentPostView = {
  postId: string;
  ownerUserId: string;
  generationId: string | null;
  /** How the post was composed: `text` for a text post, `media` or `mixed` for one with media. */
  format: string | null;
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
  resource: AgentPostResource;
};

export type AgentPostReadResult =
  | { ok: true; post: AgentPostView }
  | { ok: false; code: 'NOT_FOUND' | 'UNAVAILABLE' };

type PostRow = {
  id: string;
  user_id: string;
  generation_id: string | null;
  post_format?: string | null;
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

const POST_SELECT = 'id, user_id, generation_id, post_format, title, description, body, category, visibility, review_status, archived_at, tombstoned_at, is_nsfw, remixes_allowed, save_count, comment_count, remix_count, share_count, created_at';

/** The resource's row, by these four columns alone: none of them is anything it holds. */
const RESOURCE_SELECT = 'access_mode, price_usd_cents, status, retired_at';

type ResourceRow = {
  access_mode: string | null;
  price_usd_cents: number | null;
  status: string | null;
  retired_at: string | null;
};

/**
 * The three facts of a post's resource. A resource its creator removed while people held it
 * stays as a retired row and is no longer the post's. Anyone but the owner is told of one only
 * while it is on offer: a draft is the owner's business.
 */
export function toAgentPostResource(row: ResourceRow | null | undefined, isOwn: boolean): AgentPostResource {
  if (!row || row.retired_at || (row.access_mode !== 'free' && row.access_mode !== 'paid')) return AGENT_POST_NO_RESOURCE;
  const status = row.status === 'published' ? 'published' : 'draft';
  if (!isOwn && status !== 'published') return AGENT_POST_NO_RESOURCE;
  const price = typeof row.price_usd_cents === 'number' && Number.isFinite(row.price_usd_cents) ? Math.max(0, row.price_usd_cents) : 0;
  return { access: row.access_mode, priceTokens: row.access_mode === 'paid' ? price : 0, status };
}

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

export function toAgentPostView(row: PostRow, viewerUserId: string, resource: ResourceRow | null = null): AgentPostView {
  return {
    postId: row.id,
    ownerUserId: row.user_id,
    generationId: row.generation_id,
    format: row.post_format ?? null,
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
    resource: toAgentPostResource(resource, row.user_id === viewerUserId),
  };
}

/**
 * Reads one post for an agent. The service client reads it (the authenticated Data API shows a
 * viewer only live posts), and this decides what the agent may see of it. The post's resource is
 * read as its access, price and status only.
 */
export async function readPostForAgent(
  admin: SupabaseClient,
  { postId, viewerUserId }: { postId: string; viewerUserId: string },
): Promise<AgentPostReadResult> {
  const { data, error } = await admin.from('posts').select(POST_SELECT).eq('id', postId).maybeSingle();
  if (error) return { ok: false, code: 'UNAVAILABLE' };
  if (!data) return { ok: false, code: 'NOT_FOUND' };
  const row = data as PostRow;
  // Decided on the post alone, before anything of its resource is read.
  if (row.user_id !== viewerUserId && agentPostState(row) !== 'live') return { ok: false, code: 'NOT_FOUND' };
  const resource = await admin.from('post_resource_bundles').select(RESOURCE_SELECT).eq('post_id', postId).maybeSingle();
  if (resource.error) return { ok: false, code: 'UNAVAILABLE' };
  return { ok: true, post: toAgentPostView(row, viewerUserId, resource.data as ResourceRow | null) };
}
