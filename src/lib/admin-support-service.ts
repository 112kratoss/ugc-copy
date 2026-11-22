import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { runPagedQuery } from '@/lib/admin-paged-query';
import {
  SupportConversationError,
  loadSupportMessages,
  toSupportConversationSummary,
} from '@/lib/support-conversations';

import type {
  SupportConversationStatus,
  SupportConversationSummary,
  SupportMessage,
  SupportMessageAuthor,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * The console's reads of help & support conversations (/admin/support), drawn
 * as a chat app's list: who, the latest message with its ticks, when, and how
 * many of the account's messages support has not read. The conversations
 * waiting on support come first, oldest first, so none is left behind; then
 * the open ones answered and waiting on the account; then the resolved ones,
 * paged. And one conversation with its messages, which the console's thread
 * asks for again while it is open.
 */

export type AdminSupportConversation = {
  id: string;
  userId: string;
  status: SupportConversationStatus;
  /** The account wrote last and has had no reply since. */
  awaitingReply: boolean;
  createdAt: string;
  lastMessageAt: string;
  lastUserMessageAt: string | null;
  lastStaffMessageAt: string | null;
  /** The latest message's text or caption; null for a photo without one, and once it was deleted. */
  lastMessagePreview: string | null;
  /** The latest message is a photo. */
  lastMessageHasPhoto: boolean;
  lastMessageAuthor: SupportMessageAuthor | null;
  resolvedAt: string | null;
  /** The account's messages support has not read. */
  unreadCount: number;
  /** Support's latest message has been read by the account (the list's two ticks). */
  lastStaffMessageRead: boolean;
  /** The account is writing now. */
  userTyping: boolean;
  username: string | null;
  displayName: string | null;
};

const CONVERSATION_COLUMNS = [
  'id',
  'user_id',
  'status',
  'awaiting_reply',
  'created_at',
  'last_message_at',
  'last_user_message_at',
  'last_staff_message_at',
  'last_message_preview',
  'last_message_author',
  'last_message_has_photo',
  'resolved_at',
  'staff_unread_count',
  'user_last_read_at',
  'staff_last_read_at',
  'user_typing_until',
  'staff_typing_until',
].join(', ');

/** The thread the console draws: longer than a client's, since the operator reads it whole. */
export const ADMIN_SUPPORT_THREAD_MESSAGE_LIMIT = 500;

type ConversationRow = {
  id: string;
  user_id: string;
  status: string;
  awaiting_reply: boolean | null;
  created_at: string;
  last_message_at: string;
  last_user_message_at: string | null;
  last_staff_message_at: string | null;
  last_message_preview: string | null;
  last_message_author: string | null;
  last_message_has_photo: boolean | null;
  resolved_at: string | null;
  staff_unread_count: number | null;
  user_last_read_at: string | null;
  staff_last_read_at: string | null;
  user_typing_until: string | null;
  staff_typing_until: string | null;
};

type ProfileRow = { id: string; username: string | null; display_name: string | null };

function later(value: string | null, than: string | null): boolean {
  if (!value || !than) return false;
  return Date.parse(value) >= Date.parse(than);
}

async function withProfiles(
  client: SupabaseClient,
  rows: ConversationRow[],
  now: number,
): Promise<AdminSupportConversation[]> {
  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const profiles = new Map<string, ProfileRow>();

  if (userIds.length > 0) {
    const { data, error } = await client.from('profiles').select('id, username, display_name').in('id', userIds);
    // A name is a convenience here: the row still opens the account by its id.
    if (!error) {
      for (const profile of (data ?? []) as ProfileRow[]) profiles.set(profile.id, profile);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    awaitingReply: row.awaiting_reply === true,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    lastUserMessageAt: row.last_user_message_at,
    lastStaffMessageAt: row.last_staff_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageHasPhoto: row.last_message_has_photo === true,
    lastMessageAuthor: row.last_message_author === 'staff' ? 'staff' : row.last_message_author === 'user' ? 'user' : null,
    resolvedAt: row.resolved_at,
    unreadCount: Math.max(0, row.staff_unread_count ?? 0),
    lastStaffMessageRead: later(row.user_last_read_at, row.last_staff_message_at),
    userTyping: Boolean(row.user_typing_until) && Date.parse(row.user_typing_until as string) > now,
    username: profiles.get(row.user_id)?.username ?? null,
    displayName: profiles.get(row.user_id)?.display_name ?? null,
  }));
}

function failed(what: string): never {
  throw new SupportConversationError(`Failed to load ${what}.`);
}

/** A page of one of the console's lists, with how many the whole list holds. */
export type AdminSupportConversationPage = {
  conversations: AdminSupportConversation[];
  total: number;
  /** Where the page landed: the first page when the one asked for is past the end. */
  offset: number;
};

/**
 * One page of a list, by offset. A page past the end (an operator on page 2
 * whose conversations moved to another list meanwhile, or an old link) lands
 * on the first page with the list's true size, never an error.
 */
async function pageOf(
  client: SupabaseClient,
  what: string,
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown; count: number | null; status: number }>,
  { limit, offset, now }: { limit: number; offset: number; now: number },
): Promise<AdminSupportConversationPage> {
  let page: Awaited<ReturnType<typeof runPagedQuery<ConversationRow>>>;
  try {
    page = await runPagedQuery<ConversationRow>(
      async (from, to) => {
        const response = await build(from, to);
        return { ...response, data: response.data as ConversationRow[] | null };
      },
      { offset, pageSize: limit },
    );
  } catch {
    failed(what);
  }
  return {
    conversations: await withProfiles(client, page.rows, now),
    total: page.total,
    offset: page.offset,
  };
}

/** Waiting on support, the longest wait first. */
export async function listSupportConversationsAwaitingReply(
  client: SupabaseClient,
  { limit = 100, offset = 0, now = Date.now() }: { limit?: number; offset?: number; now?: number } = {},
) {
  return pageOf(client, 'the conversations waiting on support', (from, to) => client
    .from('support_conversations')
    .select(CONVERSATION_COLUMNS, { count: 'exact' })
    .eq('awaiting_reply', true)
    .order('last_user_message_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to), { limit, offset, now });
}

/** Open and answered: waiting on the account. Newest activity first. */
export async function listAnsweredOpenSupportConversations(
  client: SupabaseClient,
  { limit = 50, offset = 0, now = Date.now() }: { limit?: number; offset?: number; now?: number } = {},
) {
  return pageOf(client, 'the answered conversations', (from, to) => client
    .from('support_conversations')
    .select(CONVERSATION_COLUMNS, { count: 'exact' })
    .eq('status', 'open')
    .eq('awaiting_reply', false)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to), { limit, offset, now });
}

export async function listResolvedSupportConversations(
  client: SupabaseClient,
  { limit, offset, now = Date.now() }: { limit: number; offset: number; now?: number },
) {
  return pageOf(client, 'the resolved conversations', (from, to) => client
    .from('support_conversations')
    .select(CONVERSATION_COLUMNS, { count: 'exact' })
    .eq('status', 'resolved')
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to), { limit, offset, now });
}

/** The count on the console's Support menu item. */
export async function countSupportConversationsAwaitingReply(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from('support_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('awaiting_reply', true);
  if (error) failed('the support count');
  return count ?? 0;
}

/** One conversation as the console's thread reads it: the list's row, the clients' summary and the messages. */
export type AdminSupportThread = {
  conversation: AdminSupportConversation;
  summary: SupportConversationSummary;
  messages: SupportMessage[];
};

export async function getAdminSupportConversation(
  client: SupabaseClient,
  conversationId: string,
  { now = Date.now() }: { now?: number } = {},
): Promise<AdminSupportThread | null> {
  const { data, error } = await client
    .from('support_conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', conversationId)
    .maybeSingle();
  if (error) failed('the conversation');
  if (!data) return null;

  const row = data as unknown as ConversationRow;
  const [conversation] = await withProfiles(client, [row], now);
  const messages = await loadSupportMessages(client, conversationId, 'staff', ADMIN_SUPPORT_THREAD_MESSAGE_LIMIT);
  return {
    conversation,
    summary: toSupportConversationSummary(row, now),
    messages,
  };
}
