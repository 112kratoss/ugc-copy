import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SUPPORT_ROADMAP_SHIPPED_DAYS,
  SUPPORT_UPDATES_PAGE_SIZE,
  isSupportRoadmapStatus,
  isSupportUpdateKind,
  readSupportHubReactionCounts,
  readSupportHubReactionResponse,
  type SupportHubReactionEmoji,
  type SupportHubReactionResponse,
  type SupportRoadmapItem,
  type SupportRoadmapResponse,
  type SupportUpdate,
  type SupportUpdatesPage,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

/**
 * Help & Support's Updates and Roadmap, as every reader sees them (plan:
 * docs/plans/help-support-updates-roadmap-plan-2026-11-26.md).
 *
 * An update is a public post of the official account marked by
 * `posts.support_update_kind`; it is listed while people can see it (public,
 * not archived, not hidden by review). The roadmap is the console's list,
 * without archived items and without shipped ones past their thirty days.
 * Reactions are read with each list, with the reader's own when there is a
 * reader, and change only through the database functions.
 */

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is an id the routes take (a post's or a roadmap item's). */
export function isSupportHubId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

type UpdateRow = {
  id: string;
  support_update_kind: string | null;
  title: string | null;
  body: string | null;
  created_at: string;
  comment_count: number | null;
  comments_locked: boolean | null;
};

type ReactionsRow = { reactions: unknown; my_reaction: string | null };

const UPDATE_COLUMNS = 'id, support_update_kind, title, body, created_at, comment_count, comments_locked';

type UpdatesCursor = { createdAt: string; id: string };

/** A later page's place: after the update published at `createdAt` with that id. */
export function encodeSupportUpdatesCursor(cursor: UpdatesCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/** The place a cursor names, or null for one this server did not write. */
export function decodeSupportUpdatesCursor(value: string | null | undefined): UpdatesCursor | null {
  if (!value || value.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || !isSupportHubId(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** A page size the list takes: 1 to 20, 20 when none or anything else is asked. */
export function normalizeSupportUpdatesLimit(value: string | null): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= SUPPORT_UPDATES_PAGE_SIZE ? parsed : SUPPORT_UPDATES_PAGE_SIZE;
}

/** A filter value inside PostgREST's `or=(…)`, quoted since a timestamp holds `.` and `:`. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`;
}

async function readReactions(
  adminSupabase: SupabaseClient,
  fn: 'support_update_reactions_for' | 'support_roadmap_reactions_for',
  ids: string[],
  viewerUserId: string | null,
): Promise<Map<string, ReactionsRow>> {
  const byId = new Map<string, ReactionsRow>();
  if (ids.length === 0) return byId;
  const args = fn === 'support_update_reactions_for'
    ? { p_post_ids: ids, p_user_id: viewerUserId }
    : { p_item_ids: ids, p_user_id: viewerUserId };
  const { data, error } = await adminSupabase.rpc(fn, args);
  if (error) throw error;
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = (row.post_id ?? row.item_id) as string | undefined;
    if (id) byId.set(id, { reactions: row.reactions, my_reaction: (row.my_reaction as string | null) ?? null });
  }
  return byId;
}

function readMyReaction(value: string | null | undefined): SupportHubReactionEmoji | null {
  return readSupportHubReactionResponse({ myReaction: value ?? null, reactions: {} })?.myReaction ?? null;
}

/** A page of the updates people can see, newest first, with their reactions and the reader's own. */
export async function listSupportUpdates({
  adminSupabase,
  viewerUserId,
  cursor,
  limit = SUPPORT_UPDATES_PAGE_SIZE,
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string | null;
  cursor: string | null;
  limit?: number;
}): Promise<SupportUpdatesPage> {
  const after = decodeSupportUpdatesCursor(cursor);
  let query = adminSupabase
    .from('posts')
    .select(UPDATE_COLUMNS)
    .not('support_update_kind', 'is', null)
    .eq('visibility', 'public')
    .is('archived_at', null)
    .eq('review_status', 'visible');
  if (after) {
    query = query.or(
      `created_at.lt.${quoted(after.createdAt)},and(created_at.eq.${quoted(after.createdAt)},id.lt.${quoted(after.id)})`,
    );
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (error) throw error;

  const rows = ((data ?? []) as UpdateRow[]).filter((row) => isSupportUpdateKind(row.support_update_kind));
  const pageRows = rows.slice(0, limit);
  const reactions = await readReactions(adminSupabase, 'support_update_reactions_for', pageRows.map((row) => row.id), viewerUserId);

  const updates: SupportUpdate[] = pageRows.map((row) => {
    const read = reactions.get(row.id);
    return {
      id: row.id,
      kind: row.support_update_kind as SupportUpdate['kind'],
      title: row.title ?? '',
      body: row.body ?? '',
      createdAt: row.created_at,
      commentCount: Math.max(0, row.comment_count ?? 0),
      commentsLocked: row.comments_locked === true,
      reactions: readSupportHubReactionCounts(read?.reactions),
      myReaction: viewerUserId ? readMyReaction(read?.my_reaction) : null,
    };
  });

  const last = pageRows[pageRows.length - 1];
  return {
    updates,
    nextCursor: rows.length > limit && last ? encodeSupportUpdatesCursor({ createdAt: last.created_at, id: last.id }) : null,
    latestAt: after ? null : updates[0]?.createdAt ?? null,
  };
}

type RoadmapRow = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  shipped_at: string | null;
  shipped_update_post_id: string | null;
};

/** The roadmap as people see it, with each item's reactions and the reader's own. */
export async function listSupportRoadmap({
  adminSupabase,
  viewerUserId,
  now = Date.now(),
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string | null;
  now?: number;
}): Promise<SupportRoadmapResponse> {
  const shippedSince = new Date(now - SUPPORT_ROADMAP_SHIPPED_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await adminSupabase
    .from('support_roadmap_items')
    .select('id, title, summary, status, shipped_at, shipped_update_post_id')
    .is('archived_at', null)
    .or(`status.neq.shipped,shipped_at.gte.${quoted(shippedSince)}`)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;

  const rows = ((data ?? []) as RoadmapRow[]).filter((row) => isSupportRoadmapStatus(row.status));
  const reactions = await readReactions(adminSupabase, 'support_roadmap_reactions_for', rows.map((row) => row.id), viewerUserId);

  const items: SupportRoadmapItem[] = rows.map((row) => {
    const read = reactions.get(row.id);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary ?? '',
      status: row.status as SupportRoadmapItem['status'],
      shippedAt: row.shipped_at,
      shippedUpdateId: row.shipped_update_post_id,
      reactions: readSupportHubReactionCounts(read?.reactions),
      myReaction: viewerUserId ? readMyReaction(read?.my_reaction) : null,
    };
  });
  return { items };
}

export type SupportHubReactionResult =
  | { ok: true; value: SupportHubReactionResponse }
  | { ok: false; status: 400 | 404; code: 'INVALID_REACTION' | 'NOT_FOUND'; error: string };

function reactionResult(data: unknown, notFound: string): SupportHubReactionResult {
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (record.status === 'reacted') {
    const value = readSupportHubReactionResponse(record);
    if (value) return { ok: true, value };
  }
  if (record.status === 'not_found') {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: notFound };
  }
  return { ok: false, status: 400, code: 'INVALID_REACTION', error: 'Choose one of the quick reactions.' };
}

/** Sets or clears the account's reaction on an update people can see. */
export async function setSupportUpdateReaction({
  adminSupabase,
  userId,
  postId,
  emoji,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  postId: string;
  emoji: SupportHubReactionEmoji | null;
}): Promise<SupportHubReactionResult> {
  const { data, error } = await adminSupabase.rpc('set_support_update_reaction', {
    p_user_id: userId,
    p_post_id: postId,
    p_emoji: emoji,
  });
  if (error) throw error;
  return reactionResult(data, 'That update is no longer available.');
}

/** Sets or clears the account's reaction on a roadmap item. */
export async function setSupportRoadmapReaction({
  adminSupabase,
  userId,
  itemId,
  emoji,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  itemId: string;
  emoji: SupportHubReactionEmoji | null;
}): Promise<SupportHubReactionResult> {
  const { data, error } = await adminSupabase.rpc('set_support_roadmap_reaction', {
    p_user_id: userId,
    p_item_id: itemId,
    p_emoji: emoji,
  });
  if (error) throw error;
  return reactionResult(data, 'That roadmap item is no longer available.');
}
