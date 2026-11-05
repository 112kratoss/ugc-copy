import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { NSFW_TITLE } from '@/lib/nsfw-content';
import { deriveTitleFromBody } from '@/lib/posts-server';
import {
  buildRemixCredit,
  type RemixCredit,
  type RemixCreditCreator,
} from '../../ugc-mobile/lib/remix-credit/remix-credit';

/**
 * A remix post's credit, read for the cards and pages that draw it
 * (`ugc-mobile/lib/remix-credit`). The post stores whom it credits
 * (20261105150143): the post its creation remixed, that post's creator and the
 * chain's first creator, written when the post was made and kept. A read adds
 * only what may change since: the post remixed's title and whether it is still
 * public and visible, and the people's handles, which the reads that hydrate a
 * card fetch beside their creators' own.
 */

/** The columns the credit is stored in, for every read that hydrates a card. */
export const POST_REMIX_CREDIT_COLUMNS = 'remix_parent_post_id, remix_parent_user_id, remix_origin_user_id';

export type PostRemixCreditFields = {
  remix_parent_post_id?: string | null;
  remix_parent_user_id?: string | null;
  remix_origin_user_id?: string | null;
};

/** The post remixed as a credit reads it. */
export type RemixCreditParentPost = {
  id: string;
  title: string;
  /** Public, visible and not archived: what anyone may open. */
  linkable: boolean;
};

type RemixCreditParentRow = {
  id: string;
  title: string | null;
  body: string | null;
  post_format: string | null;
  visibility: string | null;
  review_status: string | null;
  archived_at: string | null;
  is_nsfw: boolean | null;
};

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

/** Everyone the posts' credits name, for the read of their creators' profiles. */
export function postRemixCreditUserIds(rows: PostRemixCreditFields[]): string[] {
  return uniqueIds(rows.flatMap((row) => [row.remix_parent_user_id, row.remix_origin_user_id]));
}

/**
 * The title a credit gives the post remixed: its own, else the start of its
 * writing, as its card names it; "Mature content" for a post under its NSFW
 * cover, which a credit never uncovers. Never the prompt, which a paid recipe
 * keeps private.
 */
export function remixCreditParentTitle(row: Pick<RemixCreditParentRow, 'title' | 'body' | 'post_format' | 'is_nsfw'>): string {
  if (row.is_nsfw) return NSFW_TITLE;
  return row.title?.trim()
    || deriveTitleFromBody(row.body)
    || (row.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation');
}

/**
 * The posts the rows' credits name, in one read, and none when no row is a
 * remix. A post that is gone is absent. Null when they could not be read: those
 * credits are then left out, unknown and never none.
 */
export async function loadRemixCreditParents(
  adminSupabase: SupabaseClient,
  rows: PostRemixCreditFields[],
): Promise<Map<string, RemixCreditParentPost> | null> {
  const parentIds = uniqueIds(rows.map((row) => row.remix_parent_post_id));
  if (parentIds.length === 0) return new Map();

  const { data, error } = await adminSupabase
    .from('posts')
    .select('id, title, body, post_format, visibility, review_status, archived_at, is_nsfw')
    .in('id', parentIds);
  if (error) {
    logBackendError('failed_to_load_remix_credit_parents', { error });
    return null;
  }

  return new Map(((data ?? []) as RemixCreditParentRow[]).map((row) => [row.id, {
    id: row.id,
    title: remixCreditParentTitle(row),
    linkable: row.visibility === 'public' && row.review_status === 'visible' && !row.archived_at,
  }]));
}

/** A person as a credit names them, from a profile read: by their handle, or not at all. */
export function remixCreditCreator(
  profile: { id: string; username: string | null } | null | undefined,
): RemixCreditCreator | null {
  const username = profile?.username?.trim();
  return profile?.id && username ? { id: profile.id, username } : null;
}

/**
 * The credit one post carries, from its stored ids, the posts remixed and the
 * people named (`creatorOf`, null for anyone without a handle to name).
 * Undefined for a post that is no remix, for one whose post remixed could not
 * be read, and for one with nothing it may show.
 */
export function postRemixCredit(
  row: PostRemixCreditFields & { user_id: string | null },
  parents: Map<string, RemixCreditParentPost> | null,
  creatorOf: (userId: string) => RemixCreditCreator | null,
): RemixCredit | undefined {
  if (!row.remix_parent_post_id && !row.remix_origin_user_id) return undefined;
  if (row.remix_parent_post_id && !parents) return undefined;

  return buildRemixCredit({
    postCreatorId: row.user_id,
    parentPost: row.remix_parent_post_id ? parents?.get(row.remix_parent_post_id) ?? null : null,
    parentCreator: row.remix_parent_user_id ? creatorOf(row.remix_parent_user_id) : null,
    originCreator: row.remix_origin_user_id ? creatorOf(row.remix_origin_user_id) : null,
  }) ?? undefined;
}

/**
 * One post's credit, for a page that reads the post alone: the post remixed and
 * the people named, read together. Undefined as `postRemixCredit` answers, and
 * when the people could not be read.
 */
export async function loadPostRemixCredit(
  adminSupabase: SupabaseClient,
  row: PostRemixCreditFields & { user_id: string | null },
): Promise<RemixCredit | undefined> {
  if (!row.remix_parent_post_id && !row.remix_origin_user_id) return undefined;

  const userIds = postRemixCreditUserIds([row]);
  const [parents, profiles] = await Promise.all([
    loadRemixCreditParents(adminSupabase, [row]),
    userIds.length > 0
      ? adminSupabase.from('profiles').select('id, username').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (profiles.error) {
    logBackendError('failed_to_load_remix_credit_profiles', { error: profiles.error });
    return undefined;
  }

  const profileById = new Map(
    ((profiles.data ?? []) as Array<{ id: string; username: string | null }>).map((profile) => [profile.id, profile]),
  );
  return postRemixCredit(row, parents, (userId) => remixCreditCreator(profileById.get(userId)));
}
