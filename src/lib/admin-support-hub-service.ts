import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { buildAgentComposedPostFormData } from '@/lib/agent-upload-publish-request';
import { logBackendError } from '@/lib/backend-logger';
import { pushStoredMobileNotifications } from '@/lib/mobile-notifications';
import { createOwnerPostForRoute } from '@/lib/post-create-route-service';
import { isSupportHubId } from '@/lib/support-hub-service';

import {
  SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH,
  SUPPORT_ROADMAP_TITLE_MAX_LENGTH,
  SUPPORT_UPDATE_BODY_MAX_LENGTH,
  SUPPORT_UPDATE_TITLE_MAX_LENGTH,
  isSupportRoadmapStatus,
  isSupportUpdateKind,
  readSupportHubReactionCounts,
  supportHubReactionPeople,
  supportRoadmapShippedAlertWords,
  supportUpdateAlertWords,
  type SupportRoadmapStatus,
  type SupportUpdateKind,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';

/**
 * The console's side of Help & Support's Updates and Roadmap (`/admin/updates`).
 *
 * Publishing an update makes a public text post of the official account (the
 * profile holding the reserved handle `magicbooklet`) through the composer's
 * own create, the path an agent's text post takes, so the public-post rules,
 * moderation and search treat it as any post; then `set_support_update` marks
 * it. Announcing it starts a broadcast: `support_update_alert_batch` writes
 * the alerts a batch at a time, each account at most once, and the pushes
 * follow where chosen. It runs behind the publish's response and, should it
 * stop short of the end, "Continue sending" picks it up where it stopped.
 */

export type SupportUpdateAnnounce = 'quiet' | 'alert' | 'alert_push';

export function isSupportUpdateAnnounce(value: unknown): value is SupportUpdateAnnounce {
  return value === 'quiet' || value === 'alert' || value === 'alert_push';
}

export type AdminSupportHubResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function refusal(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

export type AdminSupportUpdate = {
  id: string;
  kind: SupportUpdateKind;
  title: string;
  body: string;
  createdAt: string;
  published: boolean;
  hiddenByReview: boolean;
  commentCount: number;
  commentsLocked: boolean;
  reactionPeople: number;
  broadcast: { push: boolean; sentCount: number; finished: boolean } | null;
};

export type AdminRoadmapItem = {
  id: string;
  title: string;
  summary: string;
  status: SupportRoadmapStatus;
  position: number;
  shippedAt: string | null;
  shippedUpdateId: string | null;
  archived: boolean;
  people: number;
};

export type AdminSupportHub = {
  officialAccountReady: boolean;
  updates: AdminSupportUpdate[];
  roadmap: AdminRoadmapItem[];
};

async function officialAccountId(adminSupabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await adminSupabase.rpc('support_official_account_id');
  if (error) throw error;
  return typeof data === 'string' && isSupportHubId(data) ? data : null;
}

/** Everything the console's page draws: every update (published or taken down) and the whole roadmap. */
export async function listAdminSupportHub({ adminSupabase }: { adminSupabase: SupabaseClient }): Promise<AdminSupportHub> {
  const [official, updatesRead, roadmapRead] = await Promise.all([
    officialAccountId(adminSupabase),
    adminSupabase
      .from('posts')
      .select('id, support_update_kind, title, body, created_at, archived_at, review_status, comment_count, comments_locked')
      .not('support_update_kind', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100),
    adminSupabase
      .from('support_roadmap_items')
      .select('id, title, summary, status, position, shipped_at, shipped_update_post_id, archived_at')
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(200),
  ]);
  if (updatesRead.error) throw updatesRead.error;
  if (roadmapRead.error) throw roadmapRead.error;

  const updateRows = (updatesRead.data ?? []) as Array<Record<string, unknown>>;
  const roadmapRows = (roadmapRead.data ?? []) as Array<Record<string, unknown>>;
  const updateIds = updateRows.map((row) => String(row.id));
  const itemIds = roadmapRows.map((row) => String(row.id));

  const [updateReactions, roadmapReactions, broadcasts] = await Promise.all([
    updateIds.length
      ? adminSupabase.rpc('support_update_reactions_for', { p_post_ids: updateIds, p_user_id: null })
      : Promise.resolve({ data: [], error: null }),
    itemIds.length
      ? adminSupabase.rpc('support_roadmap_reactions_for', { p_item_ids: itemIds, p_user_id: null })
      : Promise.resolve({ data: [], error: null }),
    updateIds.length
      ? adminSupabase.from('support_update_broadcasts').select('post_id, push, sent_count, finished_at').in('post_id', updateIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (updateReactions.error) throw updateReactions.error;
  if (roadmapReactions.error) throw roadmapReactions.error;
  if (broadcasts.error) throw broadcasts.error;

  const peopleById = new Map<string, number>();
  for (const row of [...(updateReactions.data ?? []), ...(roadmapReactions.data ?? [])] as Array<Record<string, unknown>>) {
    const id = String(row.post_id ?? row.item_id ?? '');
    peopleById.set(id, supportHubReactionPeople(readSupportHubReactionCounts(row.reactions)));
  }
  const broadcastById = new Map(((broadcasts.data ?? []) as Array<Record<string, unknown>>).map((row) => [
    String(row.post_id),
    { push: row.push === true, sentCount: Number(row.sent_count ?? 0), finished: row.finished_at !== null },
  ]));

  return {
    officialAccountReady: official !== null,
    updates: updateRows
      .filter((row) => isSupportUpdateKind(row.support_update_kind))
      .map((row) => ({
        id: String(row.id),
        kind: row.support_update_kind as SupportUpdateKind,
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at),
        published: row.archived_at === null,
        hiddenByReview: row.review_status !== 'visible',
        commentCount: Number(row.comment_count ?? 0),
        commentsLocked: row.comments_locked === true,
        reactionPeople: peopleById.get(String(row.id)) ?? 0,
        broadcast: broadcastById.get(String(row.id)) ?? null,
      })),
    roadmap: roadmapRows
      .filter((row) => isSupportRoadmapStatus(row.status))
      .map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ''),
        summary: String(row.summary ?? ''),
        status: row.status as SupportRoadmapStatus,
        position: Number(row.position ?? 0),
        shippedAt: (row.shipped_at as string | null) ?? null,
        shippedUpdateId: (row.shipped_update_post_id as string | null) ?? null,
        archived: row.archived_at !== null,
        people: peopleById.get(String(row.id)) ?? 0,
      })),
  };
}

function checkUpdateWords(title: unknown, body: unknown): { title: string; body: string } | string {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!cleanTitle) return 'Give the update a title.';
  if (cleanTitle.length > SUPPORT_UPDATE_TITLE_MAX_LENGTH) return `Keep the title to ${SUPPORT_UPDATE_TITLE_MAX_LENGTH} characters.`;
  if (!cleanBody) return 'Write what the update says.';
  if (cleanBody.length > SUPPORT_UPDATE_BODY_MAX_LENGTH) return `Keep the update to ${SUPPORT_UPDATE_BODY_MAX_LENGTH.toLocaleString('en-US')} characters.`;
  return { title: cleanTitle, body: cleanBody };
}

/**
 * Publishes an update as the official account and marks it; with an announce
 * other than `quiet`, records its broadcast for `runSupportUpdateBroadcast`.
 */
export async function publishSupportUpdate({
  adminSupabase,
  kind,
  title,
  body,
  commentsLocked,
  announce,
  createPostId = randomUUID,
}: {
  adminSupabase: SupabaseClient;
  kind: unknown;
  title: unknown;
  body: unknown;
  commentsLocked: boolean;
  announce: SupportUpdateAnnounce;
  createPostId?: () => string;
}): Promise<AdminSupportHubResult<{ postId: string; announced: boolean }>> {
  if (!isSupportUpdateKind(kind)) return refusal(400, 'Choose Announcement or New.');
  const words = checkUpdateWords(title, body);
  if (typeof words === 'string') return refusal(400, words);

  const official = await officialAccountId(adminSupabase);
  if (!official) return refusal(409, 'No account holds the @magicbooklet handle, so there is nobody to post as.');

  const postId = createPostId();
  const formData = buildAgentComposedPostFormData({
    title: words.title,
    body: words.body,
    visibility: 'public',
    resourceBundle: null,
  });
  const created = await createOwnerPostForRoute({
    adminSupabase,
    ownerUserId: official,
    readFormData: async () => formData,
    createPostId: () => postId,
  });
  if (!created.ok) {
    const message = typeof created.body?.error === 'string' ? created.body.error : 'The update could not be posted.';
    return refusal(created.status >= 400 && created.status < 500 ? created.status : 500, message);
  }

  const { data: marked, error: markError } = await adminSupabase.rpc('set_support_update', {
    p_post_id: postId,
    p_kind: kind,
    p_comments_locked: commentsLocked,
  });
  if (markError || (marked as { status?: unknown } | null)?.status !== 'set') {
    // Never leave a stray post on the official profile: take it down again.
    await adminSupabase.from('posts').update({ archived_at: new Date().toISOString() }).eq('id', postId);
    if (markError) throw markError;
    return refusal(409, 'The post was made but could not be marked as an update, so it was taken down. Try again.');
  }

  if (announce !== 'quiet') {
    const alert = supportUpdateAlertWords(kind, words.title);
    const { error } = await adminSupabase.from('support_update_broadcasts').insert({
      post_id: postId,
      push: announce === 'alert_push',
      title: alert.title,
      body: alert.body,
    });
    if (error) throw error;
  }
  return { ok: true, value: { postId, announced: announce !== 'quiet' } };
}

export type SupportUpdateBroadcastProgress = { status: string; sentCount: number };

/**
 * Sends an announced update's alerts, a batch at a time, until done or out of
 * time; the pushes follow each batch where the broadcast pushes. Safe to run
 * twice at once or again later: each account is told once.
 */
export async function runSupportUpdateBroadcast({
  adminSupabase,
  postId,
  batchSize = 300,
  timeBudgetMs = 40_000,
  now = Date.now,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  batchSize?: number;
  timeBudgetMs?: number;
  now?: () => number;
}): Promise<SupportUpdateBroadcastProgress> {
  const deadline = now() + timeBudgetMs;
  let progress: SupportUpdateBroadcastProgress = { status: 'continuing', sentCount: 0 };
  while (progress.status === 'continuing' && now() < deadline) {
    const { data, error } = await adminSupabase.rpc('support_update_alert_batch', {
      p_post_id: postId,
      p_limit: batchSize,
    });
    if (error) throw error;
    const record = (data ?? {}) as { status?: unknown; sentCount?: unknown; push?: unknown; written?: unknown };
    const written = Array.isArray(record.written)
      ? (record.written as Array<{ id?: unknown; userId?: unknown }>)
        .filter((entry): entry is { id: string; userId: string } => typeof entry.id === 'string' && typeof entry.userId === 'string')
      : [];
    if (record.push === true && written.length > 0) {
      await pushStoredMobileNotifications(adminSupabase, written);
    }
    progress = {
      status: typeof record.status === 'string' ? record.status : 'not_found',
      sentCount: Number(record.sentCount ?? progress.sentCount),
    };
  }
  return progress;
}

/** Runs a broadcast behind a response, logging rather than throwing. */
export async function runSupportUpdateBroadcastQuietly(args: { adminSupabase: SupabaseClient; postId: string }) {
  try {
    await runSupportUpdateBroadcast(args);
  } catch (error) {
    logBackendError('support_update_broadcast_failed', { postId: args.postId, error });
  }
}

async function readUpdateRow(adminSupabase: SupabaseClient, postId: string) {
  const { data, error } = await adminSupabase
    .from('posts')
    .select('id, support_update_kind, comments_locked')
    .eq('id', postId)
    .not('support_update_kind', 'is', null)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; support_update_kind: string; comments_locked: boolean } | null;
}

/** Rewords an update's title and body. */
export async function editSupportUpdate({
  adminSupabase,
  postId,
  title,
  body,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  title: unknown;
  body: unknown;
}): Promise<AdminSupportHubResult<null>> {
  const words = checkUpdateWords(title, body);
  if (typeof words === 'string') return refusal(400, words);
  if (!(await readUpdateRow(adminSupabase, postId))) return refusal(404, 'That update no longer exists.');
  const { error } = await adminSupabase
    .from('posts')
    .update({ title: words.title, body: words.body })
    .eq('id', postId)
    .not('support_update_kind', 'is', null);
  if (error) throw error;
  return { ok: true, value: null };
}

/** Turns an update's comments off or on. */
export async function setSupportUpdateCommentsLocked({
  adminSupabase,
  postId,
  locked,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  locked: boolean;
}): Promise<AdminSupportHubResult<null>> {
  const row = await readUpdateRow(adminSupabase, postId);
  if (!row) return refusal(404, 'That update no longer exists.');
  const { data, error } = await adminSupabase.rpc('set_support_update', {
    p_post_id: postId,
    p_kind: row.support_update_kind,
    p_comments_locked: locked,
  });
  if (error) throw error;
  const status = (data as { status?: unknown } | null)?.status;
  if (status === 'set') return { ok: true, value: null };
  if (status === 'no_official_account') return refusal(409, 'No account holds the @magicbooklet handle any more.');
  if (status === 'not_official') return refusal(409, 'That post is no longer the official account\'s.');
  if (status === 'not_public') return refusal(409, 'That post is no longer public.');
  return refusal(404, 'That update no longer exists.');
}

/**
 * Announces an update published quietly: records its broadcast, which the
 * caller then sends behind its response. An update announced once is not
 * announced again (each account would be told once anyway).
 */
export async function announceSupportUpdate({
  adminSupabase,
  postId,
  push,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  push: boolean;
}): Promise<AdminSupportHubResult<{ postId: string }>> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select('id, support_update_kind, title, visibility, archived_at, review_status')
    .eq('id', postId)
    .not('support_update_kind', 'is', null)
    .maybeSingle();
  if (error) throw error;
  const row = data as { support_update_kind: string; title: string | null; visibility: string; archived_at: string | null; review_status: string } | null;
  if (!row || !isSupportUpdateKind(row.support_update_kind)) return refusal(404, 'That update no longer exists.');
  if (row.visibility !== 'public' || row.archived_at !== null || row.review_status !== 'visible') {
    return refusal(409, 'Only a live update can be announced. Put it back up first.');
  }
  const { data: existing, error: existingError } = await adminSupabase
    .from('support_update_broadcasts')
    .select('post_id')
    .eq('post_id', postId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return refusal(409, 'That update was already announced. Use Continue sending if it stopped short.');
  const alert = supportUpdateAlertWords(row.support_update_kind, row.title ?? '');
  const { error: insertError } = await adminSupabase.from('support_update_broadcasts').insert({
    post_id: postId,
    push,
    title: alert.title,
    body: alert.body,
  });
  if (insertError) throw insertError;
  return { ok: true, value: { postId } };
}

/** Takes an update down (archives its post) or puts it back up. */
export async function setSupportUpdatePublished({
  adminSupabase,
  postId,
  published,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  published: boolean;
}): Promise<AdminSupportHubResult<null>> {
  if (!(await readUpdateRow(adminSupabase, postId))) return refusal(404, 'That update no longer exists.');
  const { error } = await adminSupabase
    .from('posts')
    .update({ archived_at: published ? null : new Date().toISOString() })
    .eq('id', postId)
    .not('support_update_kind', 'is', null);
  if (error) throw error;
  return { ok: true, value: null };
}

function checkRoadmapWords(title: unknown, summary: unknown): { title: string; summary: string } | string {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanSummary = typeof summary === 'string' ? summary.trim() : '';
  if (!cleanTitle) return 'Give the item a title.';
  if (cleanTitle.length > SUPPORT_ROADMAP_TITLE_MAX_LENGTH) return `Keep the title to ${SUPPORT_ROADMAP_TITLE_MAX_LENGTH} characters.`;
  if (cleanSummary.length > SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH) return `Keep the line to ${SUPPORT_ROADMAP_SUMMARY_MAX_LENGTH} characters.`;
  return { title: cleanTitle, summary: cleanSummary };
}

/** Adds an item to the end of the roadmap, Exploring or Building. */
export async function createRoadmapItem({
  adminSupabase,
  title,
  summary,
  status,
}: {
  adminSupabase: SupabaseClient;
  title: unknown;
  summary: unknown;
  status: unknown;
}): Promise<AdminSupportHubResult<{ itemId: string }>> {
  const words = checkRoadmapWords(title, summary);
  if (typeof words === 'string') return refusal(400, words);
  if (status !== 'exploring' && status !== 'building') return refusal(400, 'A new item is Exploring or Building.');
  const { data: last, error: lastError } = await adminSupabase
    .from('support_roadmap_items')
    .select('position')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  const position = Number((last as { position?: number } | null)?.position ?? -1) + 1;
  const { data, error } = await adminSupabase
    .from('support_roadmap_items')
    .insert({ title: words.title, summary: words.summary, status, position })
    .select('id')
    .single();
  if (error) throw error;
  return { ok: true, value: { itemId: String((data as { id: string }).id) } };
}

/** Rewords an item, or moves it between Exploring and Building (shipping has its own action). */
export async function updateRoadmapItem({
  adminSupabase,
  itemId,
  title,
  summary,
  status,
}: {
  adminSupabase: SupabaseClient;
  itemId: string;
  title: unknown;
  summary: unknown;
  status: unknown;
}): Promise<AdminSupportHubResult<null>> {
  const words = checkRoadmapWords(title, summary);
  if (typeof words === 'string') return refusal(400, words);
  if (status !== 'exploring' && status !== 'building') return refusal(400, 'Choose Exploring or Building; ship an item with Mark shipped.');
  const { data, error } = await adminSupabase
    .from('support_roadmap_items')
    .update({ title: words.title, summary: words.summary, status })
    .eq('id', itemId)
    .neq('status', 'shipped')
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) return refusal(409, 'That item is shipped or gone; a shipped item keeps its words.');
  return { ok: true, value: null };
}

/** Archives an item (it leaves the roadmap and takes no reaction) or brings it back. */
export async function setRoadmapItemArchived({
  adminSupabase,
  itemId,
  archived,
}: {
  adminSupabase: SupabaseClient;
  itemId: string;
  archived: boolean;
}): Promise<AdminSupportHubResult<null>> {
  const { data, error } = await adminSupabase
    .from('support_roadmap_items')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', itemId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) return refusal(404, 'That item no longer exists.');
  return { ok: true, value: null };
}

/** Swaps an item with its neighbour above or below in the roadmap's order. */
export async function moveRoadmapItem({
  adminSupabase,
  itemId,
  direction,
}: {
  adminSupabase: SupabaseClient;
  itemId: string;
  direction: 'up' | 'down';
}): Promise<AdminSupportHubResult<null>> {
  const { data, error } = await adminSupabase
    .from('support_roadmap_items')
    .select('id, position')
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; position: number }>;
  const index = rows.findIndex((row) => row.id === itemId);
  if (index < 0) return refusal(404, 'That item no longer exists.');
  const other = rows[direction === 'up' ? index - 1 : index + 1];
  if (!other) return { ok: true, value: null };
  // Renumber in order first, so two items that shared a position still move.
  const ordered = rows.map((row, position) => ({ ...row, position }));
  const mine = ordered[index]!;
  const theirs = ordered[direction === 'up' ? index - 1 : index + 1]!;
  [mine.position, theirs.position] = [theirs.position, mine.position];
  for (const row of ordered) {
    const { error: writeError } = await adminSupabase
      .from('support_roadmap_items')
      .update({ position: row.position })
      .eq('id', row.id);
    if (writeError) throw writeError;
  }
  return { ok: true, value: null };
}

/** Marks an item shipped with the update that announced it, and tells everyone who reacted. */
export async function shipRoadmapItem({
  adminSupabase,
  itemId,
  updatePostId,
}: {
  adminSupabase: SupabaseClient;
  itemId: string;
  updatePostId: string;
}): Promise<AdminSupportHubResult<{ told: number }>> {
  const { data: item, error: itemError } = await adminSupabase
    .from('support_roadmap_items')
    .select('title')
    .eq('id', itemId)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!item) return refusal(404, 'That item no longer exists.');
  const words = supportRoadmapShippedAlertWords(String((item as { title: string }).title));
  const { data, error } = await adminSupabase.rpc('ship_support_roadmap_item', {
    p_item_id: itemId,
    p_update_post_id: updatePostId,
    p_title: words.title,
    p_body: words.body,
  });
  if (error) throw error;
  const record = (data ?? {}) as { status?: unknown; written?: unknown };
  if (record.status === 'update_not_found') return refusal(409, 'Choose a published update to ship it with.');
  if (record.status !== 'shipped') return refusal(404, 'That item is archived or no longer exists.');
  const written = Array.isArray(record.written)
    ? (record.written as Array<{ id?: unknown; userId?: unknown }>)
      .filter((entry): entry is { id: string; userId: string } => typeof entry.id === 'string' && typeof entry.userId === 'string')
    : [];
  if (written.length > 0) await pushStoredMobileNotifications(adminSupabase, written);
  return { ok: true, value: { told: written.length } };
}
