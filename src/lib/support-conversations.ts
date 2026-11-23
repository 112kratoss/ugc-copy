import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  notifySupportReplied,
  rewordSupportReplyNotification,
  withdrawSupportReplyNotification,
} from '@/lib/mobile-notifications';
import { logBackendWarning } from '@/lib/backend-logger';
import { isDefinitiveSupabaseMutationRejection } from '@/lib/upload-byte-admission';
import {
  claimStagedSupportPhoto,
  encodeSupportPhoto,
  releaseStagedSupportPhoto,
  removeSupportPhotoCopies,
  settleStagedSupportPhoto,
  signSupportPhotoLinks,
  storeSupportPhoto,
  supportPhotoAttachmentArgument,
  toSupportPhoto,
  type StagedSupportPhotoClaim,
  type StoredSupportPhoto,
} from '@/lib/support-photos';

import {
  SUPPORT_REFUSAL_WORDS,
  SUPPORT_THREAD_MESSAGE_LIMIT,
  checkSupportMessage,
  isSupportReactionEmoji,
  type SupportConversationRef,
  type SupportConversationStatus,
  type SupportConversationSummary,
  type SupportMessage,
  type SupportMessageAuthor,
  type SupportMessageRefusalCode,
  type SupportQuotedMessage,
  type SupportReaction,
  type SupportReactionEmoji,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * Help & support conversations. One conversation per account, worked like a
 * chat app (owner, 2026-11-22): read receipts, unread counts, typing, replies
 * that quote, reactions, edits within 15 minutes, deletes for everyone within
 * 48 hours, and a photo on a message. The account writes through
 * `/api/support/conversation` and `/api/support/messages/:id`, the operator
 * from `/admin/support`, and every write goes through one of the functions of
 * migration 20261122150427, which keep each change and the conversation's
 * times in one transaction. The tables are the service role's alone; a
 * photo's copies are kept and signed by `src/lib/support-photos.ts`.
 */

export class SupportConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportConversationError';
  }
}

type SupportMessageRow = {
  id: string;
  author: string;
  client_message_id: string | null;
  body: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_message_id: string | null;
  attachment_kind: string | null;
  attachment_path: string | null;
  attachment_preview_path: string | null;
  attachment_width: number | null;
  attachment_height: number | null;
  attachment_thumbhash: string | null;
};

type SupportReactionRow = {
  message_id: string;
  author: string;
  emoji: string;
};

type SupportQuotedRow = {
  id: string;
  author: string;
  body: string | null;
  deleted_at: string | null;
  attachment_kind?: string | null;
};

/** A message's photo as the support functions answer it: the copies' paths, for the server alone. */
type SupportAttachmentPayload = {
  kind?: string | null;
  path?: string | null;
  preview_path?: string | null;
  width?: number | null;
  height?: number | null;
  thumbhash?: string | null;
};

/** A message as the support functions answer it (`support_message_payload`). */
type SupportMessagePayload = {
  id?: string;
  author?: string;
  /** The writer's own id for the message: answered to the side that wrote it only. */
  client_message_id?: string | null;
  body?: string | null;
  created_at?: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  attachment?: SupportAttachmentPayload | null;
  reply_to?: SupportQuotedRow | null;
  reactions?: Array<{ author?: string; emoji?: string }> | null;
};

type SupportConversationRow = {
  id: string;
  user_id: string;
  status: string;
  user_last_read_at: string | null;
  staff_last_read_at: string | null;
  user_typing_until: string | null;
  staff_typing_until: string | null;
};

export const SUPPORT_CONVERSATION_COLUMNS = [
  'id',
  'user_id',
  'status',
  'user_last_read_at',
  'staff_last_read_at',
  'user_typing_until',
  'staff_typing_until',
].join(', ');

const SUPPORT_MESSAGE_COLUMNS = [
  'id',
  'author',
  'client_message_id',
  'body',
  'created_at',
  'edited_at',
  'deleted_at',
  'reply_to_message_id',
  'attachment_kind',
  'attachment_path',
  'attachment_preview_path',
  'attachment_width',
  'attachment_height',
  'attachment_thumbhash',
].join(', ');

function toAuthor(value: unknown): SupportMessageAuthor {
  return value === 'staff' ? 'staff' : 'user';
}

function toConversationStatus(value: unknown): SupportConversationStatus {
  return value === 'resolved' ? 'resolved' : 'open';
}

function toQuoted(row: SupportQuotedRow | null | undefined): SupportQuotedMessage | null {
  if (!row?.id) return null;
  const hasPhoto = !row.deleted_at && Boolean(row.attachment_kind);
  const deleted = Boolean(row.deleted_at) || (row.body === null && !hasPhoto);
  return { id: row.id, author: toAuthor(row.author), body: deleted ? null : row.body, deleted, hasPhoto };
}

/** A payload's photo as the server keeps it; null for none or one missing a part. */
function storedPhotoOf(payload: SupportMessagePayload) {
  const attachment = payload.attachment;
  if (payload.deleted_at || !attachment || attachment.kind !== 'image') return null;
  const { path, preview_path: previewPath, width, height } = attachment;
  if (!path || !previewPath || !width || !height || width <= 0 || height <= 0) return null;
  return { path, previewPath, width, height, thumbhash: attachment.thumbhash ?? null };
}

/** Every photo copy the payloads name, for one signing call. */
export function supportPhotoPathsOf(payloads: readonly SupportMessagePayload[]): string[] {
  return payloads.flatMap((payload) => {
    const stored = storedPhotoOf(payload);
    return stored ? [stored.previewPath, stored.path] : [];
  });
}

function messageRowPayload(row: SupportMessageRow): SupportMessagePayload {
  return {
    ...row,
    attachment: row.attachment_kind
      ? {
        kind: row.attachment_kind,
        path: row.attachment_path,
        preview_path: row.attachment_preview_path,
        width: row.attachment_width,
        height: row.attachment_height,
        thumbhash: row.attachment_thumbhash,
      }
      : null,
  };
}

function toReactions(rows: Array<{ author?: string; emoji?: string }> | null | undefined): SupportReaction[] {
  const reactions: SupportReaction[] = [];
  for (const row of rows ?? []) {
    if (!isSupportReactionEmoji(row.emoji)) continue;
    const author = toAuthor(row.author);
    if (reactions.some((reaction) => reaction.author === author)) continue;
    reactions.push({ author, emoji: row.emoji });
  }
  return reactions;
}

/**
 * A message as a support function answered it, in the API's shape: its photo
 * with the links `links` holds for its copies (none signed: none drawn), and
 * the client's own id when `viewer` wrote it, by which that side settles the
 * copy it drew while the message was on its way.
 */
export function toSupportMessage(
  payload: SupportMessagePayload,
  links: ReadonlyMap<string, string> = new Map(),
  now: number = Date.now(),
  viewer: SupportMessageAuthor | null = null,
): SupportMessage {
  const deletedAt = payload.deleted_at ?? null;
  const stored = storedPhotoOf(payload);
  const author = toAuthor(payload.author);
  return {
    id: String(payload.id),
    author,
    clientMessageId: viewer !== null && author === viewer ? payload.client_message_id ?? null : null,
    body: deletedAt ? null : payload.body ?? null,
    createdAt: String(payload.created_at),
    editedAt: payload.edited_at ?? null,
    deletedAt,
    replyTo: toQuoted(payload.reply_to),
    reactions: deletedAt ? [] : toReactions(payload.reactions),
    attachment: stored ? toSupportPhoto(stored, links, now) : null,
  };
}

/**
 * Messages in the API's shape for `viewer`, their photos' links signed in one
 * call. Signing that fails costs the links, never the answer: a photo is
 * answered with null links (the clients say it could not be loaded, and the
 * next read signs anew), so a write that was kept is never answered as a
 * fault.
 */
async function toSignedSupportMessages(
  adminSupabase: SupabaseClient,
  payloads: readonly SupportMessagePayload[],
  viewer: SupportMessageAuthor,
): Promise<SupportMessage[]> {
  const paths = supportPhotoPathsOf(payloads);
  let links: Map<string, string> = new Map();
  if (paths.length > 0) {
    try {
      links = await signSupportPhotoLinks(adminSupabase, paths);
    } catch (error) {
      logBackendWarning('support_photo_sign_failed', {
        error: error instanceof Error ? error.message : String(error),
        count: paths.length,
      });
    }
  }
  const now = Date.now();
  return payloads.map((payload) => toSupportMessage(payload, links, now, viewer));
}

/** Ids a read filters on at once, to keep its URL short: a console thread names up to 500. */
const SUPPORT_ID_READ_CHUNK = 100;

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** The conversation's state as both clients read it. Typing is a time still to come. */
export function toSupportConversationSummary(row: SupportConversationRow, now: number = Date.now()): SupportConversationSummary {
  const typing = (until: string | null) => Boolean(until) && Date.parse(until as string) > now;
  return {
    id: row.id,
    status: toConversationStatus(row.status),
    userLastReadAt: row.user_last_read_at,
    staffLastReadAt: row.staff_last_read_at,
    userTyping: typing(row.user_typing_until),
    staffTyping: typing(row.staff_typing_until),
  };
}

/**
 * The newest messages of a conversation, oldest first: what a thread draws
 * for `viewer`, with each one's reactions and the message it quotes. Read
 * newest first so the limit keeps the end of a long conversation.
 */
export async function loadSupportMessages(
  adminSupabase: SupabaseClient,
  conversationId: string,
  viewer: SupportMessageAuthor,
  limit = SUPPORT_THREAD_MESSAGE_LIMIT,
): Promise<SupportMessage[]> {
  const { data, error } = await adminSupabase
    .from('support_messages')
    .select(SUPPORT_MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) {
    throw new SupportConversationError('Failed to load support messages.');
  }

  const rows = ((data ?? []) as unknown as SupportMessageRow[]).reverse();
  if (rows.length === 0) return [];

  const reactionsByMessage = new Map<string, SupportReactionRow[]>();
  const reactionReads = await Promise.all(chunksOf(rows.map((row) => row.id), SUPPORT_ID_READ_CHUNK).map((ids) => adminSupabase
    .from('support_message_reactions')
    .select('message_id, author, emoji')
    .in('message_id', ids)
    .order('created_at', { ascending: true })));

  for (const { data: reactionData, error: reactionError } of reactionReads) {
    if (reactionError) {
      throw new SupportConversationError('Failed to load support reactions.');
    }
    for (const reaction of (reactionData ?? []) as SupportReactionRow[]) {
      const list = reactionsByMessage.get(reaction.message_id) ?? [];
      list.push(reaction);
      reactionsByMessage.set(reaction.message_id, list);
    }
  }

  // A reply's quote comes from the rows already read; only a quote of a
  // message older than the window needs a read of its own.
  const quoted = new Map<string, SupportQuotedRow>(rows.map((row) => [row.id, row]));
  const missing = [...new Set(rows
    .map((row) => row.reply_to_message_id)
    .filter((id): id is string => Boolean(id) && !quoted.has(id as string)))];

  const quotedReads = await Promise.all(chunksOf(missing, SUPPORT_ID_READ_CHUNK).map((ids) => adminSupabase
    .from('support_messages')
    .select('id, author, body, deleted_at, attachment_kind')
    .eq('conversation_id', conversationId)
    .in('id', ids)));
  for (const { data: quotedData, error: quotedError } of quotedReads) {
    if (quotedError) {
      throw new SupportConversationError('Failed to load quoted support messages.');
    }
    for (const row of (quotedData ?? []) as SupportQuotedRow[]) quoted.set(row.id, row);
  }

  return toSignedSupportMessages(adminSupabase, rows.map((row) => ({
    ...messageRowPayload(row),
    reply_to: row.reply_to_message_id ? quoted.get(row.reply_to_message_id) ?? null : null,
    reactions: reactionsByMessage.get(row.id) ?? [],
  })), viewer);
}

async function loadConversationRow(
  adminSupabase: SupabaseClient,
  column: 'user_id' | 'id',
  value: string,
): Promise<SupportConversationRow | null> {
  const { data, error } = await adminSupabase
    .from('support_conversations')
    .select(SUPPORT_CONVERSATION_COLUMNS)
    .eq(column, value)
    .maybeSingle();

  if (error) {
    throw new SupportConversationError('Failed to load the support conversation.');
  }

  return data as SupportConversationRow | null;
}

/** The account's conversation and its messages, or none before its first message. */
export async function getSupportConversation({
  adminSupabase,
  userId,
  now = Date.now,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  now?: () => number;
}): Promise<{ conversation: SupportConversationSummary | null; messages: SupportMessage[] }> {
  const row = await loadConversationRow(adminSupabase, 'user_id', userId);
  if (!row) {
    return { conversation: null, messages: [] };
  }

  return {
    conversation: toSupportConversationSummary(row, now()),
    messages: await loadSupportMessages(adminSupabase, row.id, 'user'),
  };
}

type SupportRefusal = { ok: false; code: SupportMessageRefusalCode; error: string };

function refuse(code: SupportMessageRefusalCode): SupportRefusal {
  return { ok: false, code, error: SUPPORT_REFUSAL_WORDS[code] };
}

/** The HTTP status a refusal is answered with. */
export function supportRefusalStatus(code: SupportMessageRefusalCode | 'CONVERSATION_NOT_FOUND'): number {
  switch (code) {
    case 'CONVERSATION_NOT_FOUND':
    case 'MESSAGE_NOT_FOUND':
      return 404;
    case 'NOT_YOUR_MESSAGE':
      return 403;
    case 'MESSAGE_DELETED':
    case 'EDIT_TOO_LATE':
    case 'DELETE_TOO_LATE':
    case 'PHOTO_NOT_FOUND':
      return 409;
    case 'PHOTO_TOO_LARGE':
      return 413;
    default:
      return 400;
  }
}

/**
 * Where a message's photo comes from: one the account staged in `uploads`
 * (named by its storage path), or the console's, whose bytes come with the
 * send.
 */
export type SupportPhotoSource =
  | { kind: 'staged'; storagePath: string }
  | { kind: 'bytes'; bytes: Uint8Array };

export type SendSupportMessageResult =
  | {
    ok: true;
    /** False when the client's id named a message already kept: nothing new was written. */
    created: boolean;
    message: SupportMessage;
    conversation: SupportConversationRef;
  }
  | SupportRefusal
  | { ok: false; code: 'CONVERSATION_NOT_FOUND'; error: string };

type SupportRpcResult = {
  status?: string;
  error?: string;
  conversation_id?: string;
  conversation_status?: string;
  message?: SupportMessagePayload;
  user_last_read_at?: string | null;
  staff_last_read_at?: string | null;
  /** A delete's photo copies, inside support_attachments, for Storage to remove. */
  removed_paths?: unknown;
};

/**
 * A support function's call that failed. `refused` when the database is
 * known to have turned it down (a 4xx answer): any other failure may have lost
 * the answer of a write that was kept (`upload-byte-admission.ts`).
 */
export class SupportRpcError extends SupportConversationError {
  readonly refused: boolean;

  constructor(message: string, refused: boolean) {
    super(message);
    this.name = 'SupportRpcError';
    this.refused = refused;
  }
}

async function callSupportRpc(
  adminSupabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  failure: string,
): Promise<SupportRpcResult> {
  let response: { data: unknown; error: unknown; status?: number };
  try {
    response = await adminSupabase.rpc(name, args);
  } catch {
    throw new SupportRpcError(failure, false);
  }
  if (response.error) {
    throw new SupportRpcError(failure, isDefinitiveSupabaseMutationRejection(response));
  }
  return (response.data ?? {}) as SupportRpcResult;
}

/** The database refused what the shared rule allowed: the two have drifted apart, a fault to look at. */
function drifted(name: string, result: SupportRpcResult): never {
  throw new SupportConversationError(`${name} answered ${result.status ?? 'no status'}: ${result.error ?? 'no detail'}`);
}

async function sendResult(
  adminSupabase: SupabaseClient,
  result: SupportRpcResult,
  author: SupportMessageAuthor,
): Promise<SendSupportMessageResult> {
  if (result.status === 'not_found') {
    return { ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'This conversation no longer exists.' };
  }

  if (result.status === 'reply_not_found') {
    return refuse('REPLY_NOT_FOUND');
  }

  if ((result.status === 'sent' || result.status === 'duplicate') && result.message && result.conversation_id) {
    const [message] = await toSignedSupportMessages(adminSupabase, [result.message], author);
    return {
      ok: true,
      created: result.status === 'sent',
      message,
      conversation: {
        id: result.conversation_id,
        status: toConversationStatus(result.conversation_status),
      },
    };
  }

  return drifted('send_support_message', result);
}

/**
 * The message a client's id already names in the account's conversation, as
 * the support functions answer one, with its conversation; null when there
 * is none.
 */
async function findKeptSupportMessagePayload(
  adminSupabase: SupabaseClient,
  userId: string,
  clientMessageId: string,
): Promise<SupportRpcResult | null> {
  const conversation = await loadConversationRow(adminSupabase, 'user_id', userId);
  if (!conversation) return null;

  const { data, error } = await adminSupabase
    .from('support_messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('client_message_id', clientMessageId)
    .maybeSingle();
  if (error) throw new SupportConversationError('Failed to look up the support message.');
  if (!data) return null;

  const payload = await adminSupabase.rpc('support_message_payload', { p_message_id: (data as { id: string }).id });
  if (payload.error || !payload.data) throw new SupportConversationError('Failed to load the support message.');
  return {
    status: 'duplicate',
    conversation_id: conversation.id,
    conversation_status: conversation.status,
    message: payload.data as SupportMessagePayload,
  };
}

/**
 * Adds a message to the account's conversation: the account's own (`user`),
 * which opens or reopens it, or the operator's reply (`staff`), which needs a
 * conversation the account opened. The text is held to the shared rule first,
 * and again by the database. `replyToMessageId` quotes a message of the same
 * conversation that is not deleted. `photo` adds a picture, whose copies are
 * kept under the account's folder whichever side sends it; with one, the text
 * is its caption and may be empty. A photo the database refused leaves no
 * copy behind, and a staged one goes back to the upload pipeline. Once the
 * message is kept its copies are its own, whatever fails after; and when
 * whether it was kept cannot be told (a lost answer, the message not there or
 * not there yet), everything is left for the orphan listing and the upload
 * reclaim rather than taken from a message that may stand. A send whose
 * answer was lost but whose message was kept is answered as kept.
 */
export async function sendSupportMessage({
  adminSupabase,
  userId,
  author,
  body,
  clientMessageId = null,
  replyToMessageId = null,
  photo = null,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  author: SupportMessageAuthor;
  body: unknown;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  photo?: SupportPhotoSource | null;
}): Promise<SendSupportMessageResult> {
  const checked = checkSupportMessage(body, { hasPhoto: photo !== null });
  if (!checked.ok) {
    return { ok: false, code: checked.code, error: checked.error };
  }

  const send = (attachment: StoredSupportPhoto | null) => callSupportRpc(adminSupabase, 'send_support_message', {
    p_user_id: userId,
    p_author: author,
    p_body: checked.body,
    p_client_message_id: clientMessageId,
    p_reply_to_message_id: replyToMessageId,
    p_attachment: attachment ? supportPhotoAttachmentArgument(attachment) : null,
  }, 'Failed to send the support message.');

  /**
   * After a send's call failed: the message kept under the client's id when
   * the failure may have lost the answer of a write that was kept, or null
   * when none is there. A refusal, or a failure whose outcome cannot be
   * looked up, is thrown again.
   */
  const keptAfterFailure = async (error: unknown): Promise<SupportRpcResult | null> => {
    if ((error instanceof SupportRpcError && error.refused) || !clientMessageId) throw error;
    try {
      return await findKeptSupportMessagePayload(adminSupabase, userId, clientMessageId);
    } catch {
      throw error;
    }
  };

  if (!photo) {
    let result: SupportRpcResult;
    try {
      result = await send(null);
    } catch (error) {
      // Its answer lost, a message that was kept is answered as kept: the
      // console's reply is then announced, and no copy is drawn as not sent.
      const kept = await keptAfterFailure(error);
      if (!kept) throw error;
      result = kept;
    }
    return sendResult(adminSupabase, result, author);
  }

  // A retried photo send is answered here, before its staged photo is looked
  // for: the first send claimed it and removed it from `uploads`.
  if (clientMessageId) {
    const kept = await findKeptSupportMessagePayload(adminSupabase, userId, clientMessageId);
    if (kept) return sendResult(adminSupabase, kept, author);
  }

  let staged: StagedSupportPhotoClaim | null = null;
  let input: Uint8Array;
  if (photo.kind === 'staged') {
    const claimed = await claimStagedSupportPhoto(adminSupabase, { userId, storagePath: photo.storagePath });
    if (!claimed.ok) return refuse(claimed.code);
    staged = claimed.staged;
    input = staged.bytes;
  } else {
    input = photo.bytes;
  }

  let stored: StoredSupportPhoto;
  try {
    const encoded = await encodeSupportPhoto(input);
    if (!encoded.ok) {
      if (staged) await releaseStagedSupportPhoto(adminSupabase, staged.claim);
      return refuse(encoded.code);
    }
    stored = await storeSupportPhoto(adminSupabase, { ownerUserId: userId, photo: encoded.photo });
  } catch (error) {
    if (staged) await releaseStagedSupportPhoto(adminSupabase, staged.claim);
    throw error;
  }

  /** The database is known not to have kept these copies: they go, and a staged photo goes back. */
  const letGo = async () => {
    await removeSupportPhotoCopies(adminSupabase, [stored.path, stored.previewPath]);
    if (staged) await releaseStagedSupportPhoto(adminSupabase, staged.claim);
  };

  let result: SupportRpcResult;
  try {
    result = await send(stored);
  } catch (error) {
    if (error instanceof SupportRpcError && error.refused) {
      await letGo();
      throw error;
    }
    // The answer was lost, and the message may stand: it is looked for by the
    // client's id. Not there (yet: the call may still be running) or not to
    // be told, nothing is touched, and the orphan listing and the upload
    // reclaim settle the copies and the staged photo if no message names them.
    const kept = await keptAfterFailure(error);
    if (!kept?.message) throw error;
    if (storedPhotoOf(kept.message)?.path !== stored.path) {
      // Kept by another try, with copies of its own.
      await letGo();
      return sendResult(adminSupabase, kept, author);
    }
    result = { ...kept, status: 'sent' };
  }

  if (result.status !== 'sent') {
    await letGo();
    return sendResult(adminSupabase, result, author);
  }

  // Kept: from here the copies are the message's, whatever else fails. A
  // staged photo left unsettled stays claimed for the reclaim sweep.
  if (staged) {
    try {
      await settleStagedSupportPhoto(adminSupabase, { staged, userId });
    } catch (error) {
      logBackendWarning('support_photo_settle_failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sendResult(adminSupabase, result, author);
}

export type SupportMessageChangeResult = { ok: true; message: SupportMessage } | SupportRefusal;

async function changeResult(
  adminSupabase: SupabaseClient,
  name: string,
  result: SupportRpcResult,
  {
    author,
    tooLate,
    deletedIsDone = false,
  }: { author: SupportMessageAuthor; tooLate: SupportMessageRefusalCode; deletedIsDone?: boolean },
): Promise<SupportMessageChangeResult> {
  const signed = async (payload: SupportMessagePayload) => {
    const [message] = await toSignedSupportMessages(adminSupabase, [payload], author);
    return { ok: true as const, message };
  };
  switch (result.status) {
    case 'edited':
    case 'unchanged':
    case 'reacted':
      if (result.message) return signed(result.message);
      return drifted(name, result);
    case 'deleted':
      // Deleting what is already deleted is done; changing it is refused.
      if (deletedIsDone && result.message) return signed(result.message);
      return refuse('MESSAGE_DELETED');
    case 'not_found':
      return refuse('MESSAGE_NOT_FOUND');
    case 'not_yours':
      return refuse('NOT_YOUR_MESSAGE');
    case 'too_late':
      return refuse(tooLate);
    default:
      return drifted(name, result);
  }
}

/** Changes the alert a reply sent the account; a failure is logged, never the change's. */
async function followReplyAlert(change: () => Promise<void>, event: string) {
  try {
    await change();
  } catch (error) {
    logBackendWarning(event, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Changes the text of the side's own message, within 15 minutes of sending
 * it. Support's reply changes the account's alert about it too.
 */
export async function editSupportMessage({
  adminSupabase,
  userId,
  author,
  messageId,
  body,
  rewordAlert = rewordSupportReplyNotification,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  author: SupportMessageAuthor;
  messageId: string;
  body: unknown;
  rewordAlert?: typeof rewordSupportReplyNotification;
}): Promise<SupportMessageChangeResult> {
  const checked = checkSupportMessage(body);
  if (!checked.ok) {
    return { ok: false, code: checked.code, error: checked.error };
  }

  const result = await callSupportRpc(adminSupabase, 'edit_support_message', {
    p_user_id: userId,
    p_author: author,
    p_message_id: messageId,
    p_body: checked.body,
  }, 'Failed to edit the support message.');

  if (author === 'staff' && result.status === 'edited') {
    await followReplyAlert(() => rewordAlert(adminSupabase, {
      userId,
      messageId,
      replyBody: checked.body,
      hasPhoto: Boolean(result.message?.attachment),
    }), 'support_reply_alert_reword_failed');
  }

  return changeResult(adminSupabase, 'edit_support_message', result, { author, tooLate: 'EDIT_TOO_LATE' });
}

/**
 * Deletes the side's own message for everyone, within 48 hours of sending it.
 * A photo's copies are removed from Storage once the database let go of them;
 * a removal that fails is logged, and the orphan listing finds the copies.
 * Support's reply takes the account's alert about it with it, which would
 * otherwise keep the reply's first words.
 */
export async function deleteSupportMessage({
  adminSupabase,
  userId,
  author,
  messageId,
  withdrawAlert = withdrawSupportReplyNotification,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  author: SupportMessageAuthor;
  messageId: string;
  withdrawAlert?: typeof withdrawSupportReplyNotification;
}): Promise<SupportMessageChangeResult> {
  const result = await callSupportRpc(adminSupabase, 'delete_support_message', {
    p_user_id: userId,
    p_author: author,
    p_message_id: messageId,
  }, 'Failed to delete the support message.');

  const removedPaths = Array.isArray(result.removed_paths)
    ? result.removed_paths.filter((path): path is string => typeof path === 'string' && path.startsWith(`${userId}/`))
    : [];
  if (removedPaths.length > 0) await removeSupportPhotoCopies(adminSupabase, removedPaths);

  if (author === 'staff' && result.status === 'deleted') {
    await followReplyAlert(
      () => withdrawAlert(adminSupabase, { userId, messageId }),
      'support_reply_alert_withdraw_failed',
    );
  }

  return changeResult(adminSupabase, 'delete_support_message', result, {
    author,
    tooLate: 'DELETE_TOO_LATE',
    deletedIsDone: true,
  });
}

/** Sets the side's reaction on a message, or takes it away (`null`). */
export async function setSupportMessageReaction({
  adminSupabase,
  userId,
  author,
  messageId,
  emoji,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  author: SupportMessageAuthor;
  messageId: string;
  emoji: unknown;
}): Promise<SupportMessageChangeResult> {
  if (emoji !== null && !isSupportReactionEmoji(emoji)) {
    return refuse('INVALID_REACTION');
  }

  const result = await callSupportRpc(adminSupabase, 'set_support_message_reaction', {
    p_user_id: userId,
    p_author: author,
    p_message_id: messageId,
    p_emoji: emoji as SupportReactionEmoji | null,
  }, 'Failed to react to the support message.');

  return changeResult(adminSupabase, 'set_support_message_reaction', result, { author, tooLate: 'MESSAGE_DELETED' });
}

/**
 * Records how far a side has read: up to the newest message it was shown
 * (`upToMessageId`), so a message kept after its last look is not read
 * unseen; the whole thread without one. Answers both sides' read times.
 */
export async function markSupportConversationRead({
  adminSupabase,
  userId,
  reader,
  upToMessageId = null,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  reader: SupportMessageAuthor;
  upToMessageId?: string | null;
}): Promise<
  | { ok: true; userLastReadAt: string | null; staffLastReadAt: string | null }
  | { ok: false; code: 'CONVERSATION_NOT_FOUND'; error: string }
> {
  const result = await callSupportRpc(adminSupabase, 'mark_support_conversation_read', {
    p_user_id: userId,
    p_reader: reader,
    p_up_to_message_id: upToMessageId,
  }, 'Failed to mark the support conversation read.');

  if (result.status === 'not_found') {
    return { ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'This conversation no longer exists.' };
  }
  if (result.status !== 'read') return drifted('mark_support_conversation_read', result);

  return {
    ok: true,
    userLastReadAt: result.user_last_read_at ?? null,
    staffLastReadAt: result.staff_last_read_at ?? null,
  };
}

/** Says that a side is writing (for a few seconds) or has stopped. No conversation yet is no-one to tell. */
export async function setSupportConversationTyping({
  adminSupabase,
  userId,
  author,
  typing,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  author: SupportMessageAuthor;
  typing: boolean;
}): Promise<{ ok: boolean }> {
  const result = await callSupportRpc(adminSupabase, 'set_support_conversation_typing', {
    p_user_id: userId,
    p_author: author,
    p_typing: typing,
  }, 'Failed to update the support typing state.');

  if (result.status === 'ok') return { ok: true };
  if (result.status === 'not_found') return { ok: false };
  return drifted('set_support_conversation_typing', result);
}

/** The account a conversation belongs to: how the console's actions find the conversation's owner. */
export async function loadSupportConversationOwner(adminSupabase: SupabaseClient, conversationId: string) {
  const row = await loadConversationRow(adminSupabase, 'id', conversationId);
  return row ? { id: row.id, userId: row.user_id, status: toConversationStatus(row.status) } : null;
}

/**
 * The operator's reply, and the account's alert about it. The alert is
 * written once per reply, under the reply's own key: a retry that finds the
 * reply kept (its first answer lost after the reply was kept) makes sure the
 * alert was written, and never writes or pushes a second one.
 */
export async function replyToSupportConversation({
  adminSupabase,
  conversationId,
  body,
  clientMessageId = null,
  replyToMessageId = null,
  photoBytes = null,
  notify = notifySupportReplied,
}: {
  adminSupabase: SupabaseClient;
  conversationId: string;
  body: unknown;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  /** The console's photo, sent with the reply; the text is then its caption. */
  photoBytes?: Uint8Array | null;
  notify?: typeof notifySupportReplied;
}): Promise<SendSupportMessageResult> {
  const conversation = await loadSupportConversationOwner(adminSupabase, conversationId);
  if (!conversation) {
    return { ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'This conversation no longer exists.' };
  }

  const result = await sendSupportMessage({
    adminSupabase,
    userId: conversation.userId,
    author: 'staff',
    body,
    clientMessageId,
    replyToMessageId,
    photo: photoBytes ? { kind: 'bytes', bytes: photoBytes } : null,
  });

  if (result.ok && !result.message.deletedAt) {
    await notify(adminSupabase, {
      userId: conversation.userId,
      conversationId: result.conversation.id,
      messageId: result.message.id,
      replyBody: result.message.body ?? '',
      hasPhoto: result.message.attachment !== null,
    });
  }

  return result;
}

/** A time as the API answers one, which a filter may carry back exactly as it came. */
const SUPPORT_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export const SUPPORT_CONVERSATION_CHANGED_WORDS = 'A new message came in. Read it, then resolve.';

/**
 * Marks a conversation resolved, or open again. The account writing again
 * reopens it by itself (`send_support_message`); this is the operator's switch.
 * A resolve names the time of the account's latest message the operator was
 * shown (`seenLastUserMessageAt`, null for none): one that came in after it
 * is not buried unanswered, and the resolve is refused as CONVERSATION_CHANGED.
 */
export async function setSupportConversationStatus({
  adminSupabase,
  conversationId,
  status,
  seenLastUserMessageAt,
  now = () => new Date(),
}: {
  adminSupabase: SupabaseClient;
  conversationId: string;
  status: SupportConversationStatus;
  /** Left out, the resolve is not held to what the operator saw. */
  seenLastUserMessageAt?: string | null;
  now?: () => Date;
}): Promise<
  | { ok: true }
  | { ok: false; code: 'CONVERSATION_NOT_FOUND' | 'CONVERSATION_CHANGED'; error: string }
> {
  if (typeof seenLastUserMessageAt === 'string' && !SUPPORT_TIME_PATTERN.test(seenLastUserMessageAt)) {
    return { ok: false, code: 'CONVERSATION_CHANGED', error: SUPPORT_CONVERSATION_CHANGED_WORDS };
  }

  let update = adminSupabase
    .from('support_conversations')
    .update({
      status,
      resolved_at: status === 'resolved' ? now().toISOString() : null,
    })
    .eq('id', conversationId);
  if (status === 'resolved' && seenLastUserMessageAt !== undefined) {
    update = seenLastUserMessageAt === null
      ? update.is('last_user_message_at', null)
      : update.or(`last_user_message_at.is.null,last_user_message_at.lte."${seenLastUserMessageAt}"`);
  }
  const { data, error } = await update.select('id');

  if (error) {
    throw new SupportConversationError('Failed to update the support conversation.');
  }

  if (!data || data.length === 0) {
    const exists = await loadConversationRow(adminSupabase, 'id', conversationId);
    return exists
      ? { ok: false, code: 'CONVERSATION_CHANGED', error: SUPPORT_CONVERSATION_CHANGED_WORDS }
      : { ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'This conversation no longer exists.' };
  }

  return { ok: true };
}
