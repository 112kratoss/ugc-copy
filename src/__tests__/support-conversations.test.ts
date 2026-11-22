import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// The photo module's Storage and image work is its own test's
// (support-photos.test.ts); here it is a set of stand-ins, so the service's
// order and its rollbacks are what is under test. The pure mappers stay real.
vi.mock('@/lib/support-photos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/support-photos')>()),
  claimStagedSupportPhoto: vi.fn(),
  encodeSupportPhoto: vi.fn(),
  storeSupportPhoto: vi.fn(),
  settleStagedSupportPhoto: vi.fn(),
  releaseStagedSupportPhoto: vi.fn(),
  removeSupportPhotoCopies: vi.fn(),
  signSupportPhotoLinks: vi.fn(),
}));

import {
  SupportConversationError,
  deleteSupportMessage,
  editSupportMessage,
  getSupportConversation,
  markSupportConversationRead,
  replyToSupportConversation,
  sendSupportMessage,
  setSupportConversationStatus,
  setSupportConversationTyping,
  setSupportMessageReaction,
  supportRefusalStatus,
  toSupportConversationSummary,
} from '@/lib/support-conversations';
import * as photos from '@/lib/support-photos';

import { SUPPORT_REFUSAL_WORDS } from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

type Row = Record<string, unknown>;

/**
 * Just enough of supabase-js for the support service: rows read by equality
 * and `in` filters, newest first with a limit, one row by `maybeSingle`, the
 * support functions, and the status update. Every call is recorded.
 */
function fakeSupabase({
  conversations = [] as Row[],
  messages = [] as Row[],
  reactions = [] as Row[],
  rpcResults = {} as Record<string, unknown>,
  rpcError = null as unknown,
  updatedIds = null as string[] | null,
} = {}) {
  const calls: Array<{ kind: string; table?: string; args?: unknown }> = [];
  const tables: Record<string, Row[]> = {
    support_conversations: conversations,
    support_messages: messages,
    support_message_reactions: reactions,
  };

  const client = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
      const builder = {
        select(columns: string) {
          calls.push({ kind: 'select', table, args: columns });
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          calls.push({ kind: 'in', table, args: [column, values] });
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        order() {
          return builder;
        },
        async limit(limit: number) {
          calls.push({ kind: 'limit', table, args: limit });
          return {
            data: [...rows()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit),
            error: null,
          };
        },
        async maybeSingle() {
          return { data: rows()[0] ?? null, error: null };
        },
        then(resolve: (value: { data: Row[]; error: null }) => void) {
          resolve({ data: rows(), error: null });
        },
        update(values: Row) {
          calls.push({ kind: 'update', table, args: values });
          return {
            eq(column: string, value: unknown) {
              calls.push({ kind: 'update-where', table, args: [column, value] });
              return {
                async select() {
                  return { data: (updatedIds ?? [value]).map((id) => ({ id })), error: null };
                },
              };
            },
          };
        },
      };
      return builder;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ kind: 'rpc', args: { name, ...(args as object) } });
      return { data: rpcResults[name] ?? null, error: rpcError };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.mocked(photos.claimStagedSupportPhoto).mockReset();
  vi.mocked(photos.encodeSupportPhoto).mockReset();
  vi.mocked(photos.storeSupportPhoto).mockReset();
  vi.mocked(photos.settleStagedSupportPhoto).mockReset().mockResolvedValue(undefined);
  vi.mocked(photos.releaseStagedSupportPhoto).mockReset().mockResolvedValue(undefined);
  vi.mocked(photos.removeSupportPhotoCopies).mockReset().mockResolvedValue(undefined);
  vi.mocked(photos.signSupportPhotoLinks).mockReset().mockImplementation(async (_client, paths) => (
    new Map(paths.map((path) => [path, `https://storage.example/sign/${path}?token=t`]))
  ));
});

const payload = (overrides: Row = {}) => ({
  id: 'message-1',
  author: 'user',
  body: 'My credits did not come back.',
  created_at: '2026-11-21T09:00:00+00:00',
  edited_at: null,
  deleted_at: null,
  reply_to: null,
  reactions: [],
  ...overrides,
});

const conversationRow = (overrides: Row = {}) => ({
  id: 'conversation-1',
  user_id: 'user-1',
  status: 'open',
  user_last_read_at: null,
  staff_last_read_at: null,
  user_typing_until: null,
  staff_typing_until: null,
  ...overrides,
});

describe('reading a conversation', () => {
  it('answers none before the account\'s first message, and reads no messages', async () => {
    const { client, calls } = fakeSupabase();
    await expect(getSupportConversation({ adminSupabase: client, userId: 'user-1' }))
      .resolves.toEqual({ conversation: null, messages: [] });
    expect(calls.some((call) => call.table === 'support_messages')).toBe(false);
  });

  it('reads the thread oldest first, with reactions and the quotes of replies, typing as a time to come', async () => {
    const { client, calls } = fakeSupabase({
      conversations: [conversationRow({
        staff_last_read_at: '2026-11-21T09:30:00+00:00',
        staff_typing_until: '2026-11-21T10:00:06+00:00',
      })],
      messages: [
        { id: 'old', conversation_id: 'conversation-1', author: 'user', body: 'Way back', created_at: '2026-11-01T09:00:00+00:00', edited_at: null, deleted_at: null, reply_to_message_id: null },
        { id: 'm1', conversation_id: 'conversation-1', author: 'user', body: 'Help', created_at: '2026-11-21T09:00:00+00:00', edited_at: null, deleted_at: null, reply_to_message_id: null },
        { id: 'm2', conversation_id: 'conversation-1', author: 'staff', body: 'On it', created_at: '2026-11-21T09:10:00+00:00', edited_at: '2026-11-21T09:11:00+00:00', deleted_at: null, reply_to_message_id: 'm1' },
        { id: 'm3', conversation_id: 'conversation-1', author: 'user', body: null, created_at: '2026-11-21T09:20:00+00:00', edited_at: null, deleted_at: '2026-11-21T09:21:00+00:00', reply_to_message_id: 'old' },
      ],
      reactions: [
        { message_id: 'm2', author: 'user', emoji: '🙏', created_at: '2026-11-21T09:12:00+00:00' },
        { message_id: 'm2', author: 'staff', emoji: '🤡', created_at: '2026-11-21T09:12:00+00:00' },
      ],
    });

    const result = await getSupportConversation({
      adminSupabase: client,
      userId: 'user-1',
      now: () => Date.parse('2026-11-21T10:00:00+00:00'),
    });

    expect(result.conversation).toEqual({
      id: 'conversation-1',
      status: 'open',
      userLastReadAt: null,
      staffLastReadAt: '2026-11-21T09:30:00+00:00',
      userTyping: false,
      staffTyping: true,
    });
    expect(result.messages.map((message) => message.id)).toEqual(['old', 'm1', 'm2', 'm3']);
    expect(result.messages[2]).toMatchObject({
      editedAt: '2026-11-21T09:11:00+00:00',
      replyTo: { id: 'm1', author: 'user', body: 'Help', deleted: false },
      reactions: [{ author: 'user', emoji: '🙏' }],
    });
    expect(result.messages[3]).toMatchObject({ body: null, deletedAt: '2026-11-21T09:21:00+00:00', replyTo: { id: 'old' } });
    // The quotes came from the rows already read: no read of its own.
    expect(calls.filter((call) => call.kind === 'in' && call.table === 'support_messages')).toEqual([]);
  });

  it('reads the quote of a message older than the window on its own', async () => {
    const { client, calls } = fakeSupabase({
      conversations: [conversationRow()],
      messages: [
        { id: 'ancient', conversation_id: 'conversation-1', author: 'staff', body: 'Long ago', created_at: '2026-01-01T09:00:00+00:00', edited_at: null, deleted_at: null, reply_to_message_id: null },
        ...Array.from({ length: 200 }, (_, index) => ({
          id: `n${index}`,
          conversation_id: 'conversation-1',
          author: 'user',
          body: `Message ${index}`,
          created_at: `2026-11-21T${String(Math.floor(index / 60) + 10).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00+00:00`,
          edited_at: null,
          deleted_at: null,
          reply_to_message_id: index === 0 ? 'ancient' : null,
        })),
      ],
    });

    const { messages } = await getSupportConversation({ adminSupabase: client, userId: 'user-1' });
    expect(messages).toHaveLength(200);
    expect(messages[0].replyTo).toEqual({ id: 'ancient', author: 'staff', body: 'Long ago', deleted: false, hasPhoto: false });
    expect(calls).toContainEqual({ kind: 'in', table: 'support_messages', args: ['id', ['ancient']] });
  });

  it('says typing only while the time is still to come', () => {
    const row = conversationRow({ user_typing_until: '2026-11-21T10:00:05Z' });
    expect(toSupportConversationSummary(row, Date.parse('2026-11-21T10:00:04Z')).userTyping).toBe(true);
    expect(toSupportConversationSummary(row, Date.parse('2026-11-21T10:00:05Z')).userTyping).toBe(false);
  });
});

describe('sending', () => {
  it('holds the text to the shared rule before the database', async () => {
    const { client, calls } = fakeSupabase();
    await expect(sendSupportMessage({ adminSupabase: client, userId: 'user-1', author: 'user', body: '   ' }))
      .resolves.toMatchObject({ ok: false, code: 'EMPTY_MESSAGE' });
    expect(calls).toEqual([]);
  });

  it('sends the trimmed text, its client id and the message it quotes', async () => {
    const { client, calls } = fakeSupabase({
      rpcResults: {
        send_support_message: {
          status: 'sent',
          conversation_id: 'conversation-1',
          conversation_status: 'open',
          message: payload({ reply_to: { id: 'staff-1', author: 'staff', body: 'Which one?', deleted_at: null } }),
        },
      },
    });

    const result = await sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: '  My credits did not come back.  ',
      clientMessageId: 'msg:abc-12345',
      replyToMessageId: 'staff-1',
    });

    expect(calls).toEqual([{
      kind: 'rpc',
      args: {
        name: 'send_support_message',
        p_user_id: 'user-1',
        p_author: 'user',
        p_body: 'My credits did not come back.',
        p_client_message_id: 'msg:abc-12345',
        p_reply_to_message_id: 'staff-1',
        p_attachment: null,
      },
    }]);
    expect(result).toEqual({
      ok: true,
      created: true,
      message: {
        id: 'message-1',
        author: 'user',
        body: 'My credits did not come back.',
        createdAt: '2026-11-21T09:00:00+00:00',
        editedAt: null,
        deletedAt: null,
        replyTo: { id: 'staff-1', author: 'staff', body: 'Which one?', deleted: false, hasPhoto: false },
        reactions: [],
        attachment: null,
      },
      conversation: { id: 'conversation-1', status: 'open' },
    });
  });

  it('answers a retried send as the copy already kept, created false', async () => {
    const { client } = fakeSupabase({
      rpcResults: { send_support_message: { status: 'duplicate', conversation_id: 'conversation-1', conversation_status: 'open', message: payload() } },
    });
    await expect(sendSupportMessage({ adminSupabase: client, userId: 'user-1', author: 'user', body: 'x', clientMessageId: 'msg:abc-12345' }))
      .resolves.toMatchObject({ ok: true, created: false });
  });

  it('refuses a reply to a message that is gone, and a staff reply with no conversation', async () => {
    const replyGone = fakeSupabase({ rpcResults: { send_support_message: { status: 'reply_not_found' } } });
    await expect(sendSupportMessage({ adminSupabase: replyGone.client, userId: 'user-1', author: 'user', body: 'x', replyToMessageId: 'gone' }))
      .resolves.toEqual({ ok: false, code: 'REPLY_NOT_FOUND', error: SUPPORT_REFUSAL_WORDS.REPLY_NOT_FOUND });

    const none = fakeSupabase({ rpcResults: { send_support_message: { status: 'not_found' } } });
    await expect(sendSupportMessage({ adminSupabase: none.client, userId: 'user-1', author: 'staff', body: 'x' }))
      .resolves.toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
  });

  it('treats a database refusal the shared rule allowed, and a failed call, as faults', async () => {
    const drift = fakeSupabase({ rpcResults: { send_support_message: { status: 'invalid', error: 'a message is 1 to 2000 characters' } } });
    await expect(sendSupportMessage({ adminSupabase: drift.client, userId: 'user-1', author: 'user', body: 'x' }))
      .rejects.toBeInstanceOf(SupportConversationError);

    const broken = fakeSupabase({ rpcError: { message: 'connection reset' } });
    await expect(sendSupportMessage({ adminSupabase: broken.client, userId: 'user-1', author: 'user', body: 'x' }))
      .rejects.toBeInstanceOf(SupportConversationError);
  });
});

describe('edits, deletes and reactions', () => {
  it('edits through the function, answering the message as it now is', async () => {
    const { client, calls } = fakeSupabase({
      rpcResults: { edit_support_message: { status: 'edited', message: payload({ body: 'Fixed', edited_at: '2026-11-21T09:05:00+00:00' }) } },
    });
    await expect(editSupportMessage({ adminSupabase: client, userId: 'user-1', author: 'user', messageId: 'message-1', body: ' Fixed ' }))
      .resolves.toMatchObject({ ok: true, message: { body: 'Fixed', editedAt: '2026-11-21T09:05:00+00:00' } });
    expect(calls[0]).toEqual({
      kind: 'rpc',
      args: { name: 'edit_support_message', p_user_id: 'user-1', p_author: 'user', p_message_id: 'message-1', p_body: 'Fixed' },
    });
  });

  it.each([
    ['too_late', 'EDIT_TOO_LATE'],
    ['not_yours', 'NOT_YOUR_MESSAGE'],
    ['deleted', 'MESSAGE_DELETED'],
    ['not_found', 'MESSAGE_NOT_FOUND'],
  ])('refuses an edit the function answers %s as %s', async (status, code) => {
    const { client } = fakeSupabase({ rpcResults: { edit_support_message: { status } } });
    await expect(editSupportMessage({ adminSupabase: client, userId: 'user-1', author: 'user', messageId: 'message-1', body: 'x' }))
      .resolves.toEqual({ ok: false, code, error: SUPPORT_REFUSAL_WORDS[code as keyof typeof SUPPORT_REFUSAL_WORDS] });
  });

  it('answers a delete of what is already deleted as done, and a late one as too late', async () => {
    const done = fakeSupabase({ rpcResults: { delete_support_message: { status: 'deleted', message: payload({ body: null, deleted_at: '2026-11-21T09:06:00+00:00' }) } } });
    await expect(deleteSupportMessage({ adminSupabase: done.client, userId: 'user-1', author: 'user', messageId: 'message-1' }))
      .resolves.toMatchObject({ ok: true, message: { body: null, deletedAt: '2026-11-21T09:06:00+00:00' } });

    const late = fakeSupabase({ rpcResults: { delete_support_message: { status: 'too_late' } } });
    await expect(deleteSupportMessage({ adminSupabase: late.client, userId: 'user-1', author: 'user', messageId: 'message-1' }))
      .resolves.toMatchObject({ ok: false, code: 'DELETE_TOO_LATE' });
  });

  it('refuses a reaction outside the quick set before the database, and passes null to take one away', async () => {
    const refused = fakeSupabase();
    await expect(setSupportMessageReaction({ adminSupabase: refused.client, userId: 'user-1', author: 'user', messageId: 'message-1', emoji: '🤡' }))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_REACTION' });
    expect(refused.calls).toEqual([]);

    const cleared = fakeSupabase({ rpcResults: { set_support_message_reaction: { status: 'reacted', message: payload() } } });
    await expect(setSupportMessageReaction({ adminSupabase: cleared.client, userId: 'user-1', author: 'staff', messageId: 'message-1', emoji: null }))
      .resolves.toMatchObject({ ok: true });
    expect(cleared.calls[0]).toMatchObject({ args: { name: 'set_support_message_reaction', p_author: 'staff', p_emoji: null } });
  });

  it('answers each refusal with the status the routes send', () => {
    expect(supportRefusalStatus('MESSAGE_NOT_FOUND')).toBe(404);
    expect(supportRefusalStatus('CONVERSATION_NOT_FOUND')).toBe(404);
    expect(supportRefusalStatus('NOT_YOUR_MESSAGE')).toBe(403);
    expect(supportRefusalStatus('EDIT_TOO_LATE')).toBe(409);
    expect(supportRefusalStatus('EMPTY_MESSAGE')).toBe(400);
    expect(supportRefusalStatus('PHOTO_NOT_FOUND')).toBe(409);
    expect(supportRefusalStatus('PHOTO_TOO_LARGE')).toBe(413);
    expect(supportRefusalStatus('PHOTO_UNREADABLE')).toBe(400);
  });
});

describe('read receipts and typing', () => {
  it('marks a side read and answers both read times', async () => {
    const { client, calls } = fakeSupabase({
      rpcResults: { mark_support_conversation_read: { status: 'read', user_last_read_at: '2026-11-21T10:00:00Z', staff_last_read_at: null } },
    });
    await expect(markSupportConversationRead({ adminSupabase: client, userId: 'user-1', reader: 'user' }))
      .resolves.toEqual({ ok: true, userLastReadAt: '2026-11-21T10:00:00Z', staffLastReadAt: null });
    expect(calls[0]).toEqual({ kind: 'rpc', args: { name: 'mark_support_conversation_read', p_user_id: 'user-1', p_reader: 'user' } });
  });

  it('says typing, and answers no conversation yet without a fault', async () => {
    const typing = fakeSupabase({ rpcResults: { set_support_conversation_typing: { status: 'ok' } } });
    await expect(setSupportConversationTyping({ adminSupabase: typing.client, userId: 'user-1', author: 'staff', typing: true }))
      .resolves.toEqual({ ok: true });
    expect(typing.calls[0]).toEqual({
      kind: 'rpc',
      args: { name: 'set_support_conversation_typing', p_user_id: 'user-1', p_author: 'staff', p_typing: true },
    });

    const none = fakeSupabase({ rpcResults: { set_support_conversation_typing: { status: 'not_found' } } });
    await expect(setSupportConversationTyping({ adminSupabase: none.client, userId: 'user-1', author: 'user', typing: true }))
      .resolves.toEqual({ ok: false });
  });
});

describe('the operator\'s reply', () => {
  it('writes as support in the account\'s conversation and tells the account once', async () => {
    const { client, calls } = fakeSupabase({
      conversations: [conversationRow()],
      rpcResults: {
        send_support_message: {
          status: 'sent',
          conversation_id: 'conversation-1',
          conversation_status: 'open',
          message: payload({ id: 'reply-1', author: 'staff', body: 'The credits are back.' }),
        },
      },
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await replyToSupportConversation({
      adminSupabase: client,
      conversationId: 'conversation-1',
      body: 'The credits are back.',
      clientMessageId: 'msg:reply-12345',
      replyToMessageId: 'message-1',
      notify,
    });

    expect(result).toMatchObject({ ok: true, created: true });
    expect(calls.find((call) => call.kind === 'rpc')?.args).toMatchObject({
      name: 'send_support_message',
      p_user_id: 'user-1',
      p_author: 'staff',
      p_reply_to_message_id: 'message-1',
    });
    expect(notify).toHaveBeenCalledWith(client, {
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'reply-1',
      replyBody: 'The credits are back.',
      hasPhoto: false,
    });
  });

  it('does not tell the account twice about a retried reply', async () => {
    const { client } = fakeSupabase({
      conversations: [conversationRow()],
      rpcResults: { send_support_message: { status: 'duplicate', conversation_id: 'conversation-1', conversation_status: 'open', message: payload({ author: 'staff' }) } },
    });
    const notify = vi.fn();
    await replyToSupportConversation({ adminSupabase: client, conversationId: 'conversation-1', body: 'x', notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('answers a conversation that is gone without writing', async () => {
    const { client, calls } = fakeSupabase();
    await expect(replyToSupportConversation({ adminSupabase: client, conversationId: 'conversation-9', body: 'x', notify: vi.fn() }))
      .resolves.toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
    expect(calls.some((call) => call.kind === 'rpc')).toBe(false);
  });
});

describe('resolving', () => {
  it('resolves with the time, and reopens without one', async () => {
    const { client, calls } = fakeSupabase();
    await setSupportConversationStatus({
      adminSupabase: client,
      conversationId: 'conversation-1',
      status: 'resolved',
      now: () => new Date('2026-11-21T12:00:00.000Z'),
    });
    await setSupportConversationStatus({ adminSupabase: client, conversationId: 'conversation-1', status: 'open' });
    expect(calls.filter((call) => call.kind === 'update').map((call) => call.args)).toEqual([
      { status: 'resolved', resolved_at: '2026-11-21T12:00:00.000Z' },
      { status: 'open', resolved_at: null },
    ]);
  });

  it('answers a conversation that is gone', async () => {
    const { client } = fakeSupabase({ updatedIds: [] });
    await expect(setSupportConversationStatus({ adminSupabase: client, conversationId: 'conversation-9', status: 'resolved' }))
      .resolves.toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
  });
});

describe('photos', () => {
  const stored = {
    kind: 'image' as const,
    path: 'user-1/photo-1.webp',
    previewPath: 'user-1/photo-1.preview.webp',
    width: 1080,
    height: 1920,
    bytes: 240_000,
    thumbhash: 'hash=',
  };
  const attachmentPayload = {
    kind: 'image',
    path: stored.path,
    preview_path: stored.previewPath,
    width: stored.width,
    height: stored.height,
    bytes: stored.bytes,
    thumbhash: stored.thumbhash,
  };
  const staged = {
    bytes: new Uint8Array([1, 2, 3]),
    claim: { uploadId: 'upload-1', userId: 'user-1', leaseId: 'lease-1', disposition: 'delete' as const },
    stagedPath: 'user-1/upload-1-photo.jpg',
  };
  const encoded = { full: Buffer.from('full'), preview: Buffer.from('preview'), width: 1080, height: 1920, thumbhash: 'hash=' };
  const sentPhoto = (overrides: Row = {}) => ({
    status: 'sent',
    conversation_id: 'conversation-1',
    conversation_status: 'open',
    message: payload({ body: null, attachment: attachmentPayload, ...overrides }),
  });

  function stagePhoto() {
    vi.mocked(photos.claimStagedSupportPhoto).mockResolvedValue({ ok: true, staged });
    vi.mocked(photos.encodeSupportPhoto).mockResolvedValue({ ok: true, photo: encoded });
    vi.mocked(photos.storeSupportPhoto).mockResolvedValue(stored);
  }

  it('reads a photo with links signed for both copies in one call, and none for a deleted one', async () => {
    const { client } = fakeSupabase({
      conversations: [conversationRow()],
      messages: [
        { id: 'p1', conversation_id: 'conversation-1', author: 'user', body: null, created_at: '2026-11-21T09:00:00+00:00', edited_at: null, deleted_at: null, reply_to_message_id: null, attachment_kind: 'image', attachment_path: stored.path, attachment_preview_path: stored.previewPath, attachment_width: 1080, attachment_height: 1920, attachment_thumbhash: 'hash=' },
        { id: 'p2', conversation_id: 'conversation-1', author: 'staff', body: 'Which screen?', created_at: '2026-11-21T09:05:00+00:00', edited_at: null, deleted_at: null, reply_to_message_id: 'p1', attachment_kind: null, attachment_path: null, attachment_preview_path: null, attachment_width: null, attachment_height: null, attachment_thumbhash: null },
        { id: 'p3', conversation_id: 'conversation-1', author: 'user', body: null, created_at: '2026-11-21T09:06:00+00:00', edited_at: null, deleted_at: '2026-11-21T09:07:00+00:00', reply_to_message_id: null, attachment_kind: null, attachment_path: null, attachment_preview_path: null, attachment_width: null, attachment_height: null, attachment_thumbhash: null },
      ],
    });

    const { messages } = await getSupportConversation({ adminSupabase: client, userId: 'user-1' });

    expect(photos.signSupportPhotoLinks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(photos.signSupportPhotoLinks).mock.calls[0][1]).toEqual([stored.previewPath, stored.path]);
    expect(messages[0]).toMatchObject({
      body: null,
      attachment: {
        kind: 'image',
        previewUrl: `https://storage.example/sign/${stored.previewPath}?token=t`,
        url: `https://storage.example/sign/${stored.path}?token=t`,
        width: 1080,
        height: 1920,
        thumbhash: 'hash=',
      },
    });
    expect(messages[1].replyTo).toEqual({ id: 'p1', author: 'user', body: null, deleted: false, hasPhoto: true });
    expect(messages[2].attachment).toBeNull();
  });

  it('claims the staged photo, keeps its copies with the message, and settles the upload', async () => {
    stagePhoto();
    const { client, calls } = fakeSupabase({ rpcResults: { send_support_message: sentPhoto() } });

    const result = await sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: '   ',
      clientMessageId: 'msg:photo-12345',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/upload-1-photo.jpg' },
    });

    expect(photos.claimStagedSupportPhoto).toHaveBeenCalledWith(client, { userId: 'user-1', storagePath: 'uploads/user-1/upload-1-photo.jpg' });
    expect(photos.encodeSupportPhoto).toHaveBeenCalledWith(staged.bytes);
    expect(photos.storeSupportPhoto).toHaveBeenCalledWith(client, { ownerUserId: 'user-1', photo: encoded });
    expect(calls.find((call) => call.kind === 'rpc' && (call.args as Row).name === 'send_support_message')?.args).toMatchObject({
      p_body: '',
      p_attachment: attachmentPayload,
    });
    expect(photos.settleStagedSupportPhoto).toHaveBeenCalledWith(client, { staged, userId: 'user-1' });
    expect(photos.releaseStagedSupportPhoto).not.toHaveBeenCalled();
    expect(photos.removeSupportPhotoCopies).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, created: true, message: { body: null, attachment: { width: 1080, height: 1920 } } });
  });

  it('answers a retried photo send from the message already kept, before looking for its staged photo', async () => {
    const { client } = fakeSupabase({
      conversations: [conversationRow()],
      messages: [{ id: 'message-1', conversation_id: 'conversation-1', client_message_id: 'msg:photo-12345' }],
      rpcResults: { support_message_payload: payload({ body: null, attachment: attachmentPayload }) },
    });

    const result = await sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: '',
      clientMessageId: 'msg:photo-12345',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/upload-1-photo.jpg' },
    });

    expect(result).toMatchObject({ ok: true, created: false, message: { id: 'message-1', attachment: { width: 1080 } } });
    expect(photos.claimStagedSupportPhoto).not.toHaveBeenCalled();
  });

  it('refuses a staged photo that is not there, before reading or writing anything', async () => {
    vi.mocked(photos.claimStagedSupportPhoto).mockResolvedValue({ ok: false, code: 'PHOTO_NOT_FOUND' });
    const { client, calls } = fakeSupabase();
    await expect(sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: 'x',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/missing.jpg' },
    })).resolves.toEqual({ ok: false, code: 'PHOTO_NOT_FOUND', error: SUPPORT_REFUSAL_WORDS.PHOTO_NOT_FOUND });
    expect(photos.encodeSupportPhoto).not.toHaveBeenCalled();
    expect(calls.some((call) => call.kind === 'rpc')).toBe(false);
  });

  it('gives an unreadable photo back to the upload pipeline, storing nothing', async () => {
    vi.mocked(photos.claimStagedSupportPhoto).mockResolvedValue({ ok: true, staged });
    vi.mocked(photos.encodeSupportPhoto).mockResolvedValue({ ok: false, code: 'PHOTO_UNREADABLE' });
    const { client, calls } = fakeSupabase();
    await expect(sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: 'x',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/upload-1-photo.jpg' },
    })).resolves.toMatchObject({ ok: false, code: 'PHOTO_UNREADABLE' });
    expect(photos.releaseStagedSupportPhoto).toHaveBeenCalledWith(client, staged.claim);
    expect(photos.storeSupportPhoto).not.toHaveBeenCalled();
    expect(calls.some((call) => call.kind === 'rpc')).toBe(false);
  });

  it('removes the copies and gives the upload back when the database does not keep the message', async () => {
    stagePhoto();
    const { client } = fakeSupabase({ rpcResults: { send_support_message: { status: 'reply_not_found' } } });
    await expect(sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: 'x',
      replyToMessageId: 'gone',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/upload-1-photo.jpg' },
    })).resolves.toMatchObject({ ok: false, code: 'REPLY_NOT_FOUND' });
    expect(photos.removeSupportPhotoCopies).toHaveBeenCalledWith(client, [stored.path, stored.previewPath]);
    expect(photos.releaseStagedSupportPhoto).toHaveBeenCalledWith(client, staged.claim);
    expect(photos.settleStagedSupportPhoto).not.toHaveBeenCalled();
  });

  it('removes the copies and gives the upload back when the send fails, and says so', async () => {
    stagePhoto();
    const { client } = fakeSupabase({ rpcError: { message: 'connection reset' } });
    await expect(sendSupportMessage({
      adminSupabase: client,
      userId: 'user-1',
      author: 'user',
      body: 'x',
      photo: { kind: 'staged', storagePath: 'uploads/user-1/upload-1-photo.jpg' },
    })).rejects.toBeInstanceOf(SupportConversationError);
    expect(photos.removeSupportPhotoCopies).toHaveBeenCalledWith(client, [stored.path, stored.previewPath]);
    expect(photos.releaseStagedSupportPhoto).toHaveBeenCalledWith(client, staged.claim);
  });

  it('sends the console\'s photo from its bytes into the account\'s folder, and the alert says Photo', async () => {
    vi.mocked(photos.encodeSupportPhoto).mockResolvedValue({ ok: true, photo: encoded });
    vi.mocked(photos.storeSupportPhoto).mockResolvedValue(stored);
    const { client } = fakeSupabase({
      conversations: [conversationRow()],
      rpcResults: { send_support_message: sentPhoto({ id: 'reply-2', author: 'staff', body: 'Here it is' }) },
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const bytes = new Uint8Array([9, 8, 7]);

    await expect(replyToSupportConversation({ adminSupabase: client, conversationId: 'conversation-1', body: 'Here it is', photoBytes: bytes, notify }))
      .resolves.toMatchObject({ ok: true, created: true });
    expect(photos.claimStagedSupportPhoto).not.toHaveBeenCalled();
    expect(photos.encodeSupportPhoto).toHaveBeenCalledWith(bytes);
    expect(photos.storeSupportPhoto).toHaveBeenCalledWith(client, { ownerUserId: 'user-1', photo: encoded });
    expect(notify).toHaveBeenCalledWith(client, {
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'reply-2',
      replyBody: 'Here it is',
      hasPhoto: true,
    });
  });

  it('removes a deleted photo\'s copies from the account\'s folder, and nothing outside it', async () => {
    const { client } = fakeSupabase({
      rpcResults: {
        delete_support_message: {
          status: 'deleted',
          message: payload({ body: null, deleted_at: '2026-11-21T09:06:00+00:00' }),
          removed_paths: [stored.path, stored.previewPath, 'someone-else/x.webp'],
        },
      },
    });
    await expect(deleteSupportMessage({ adminSupabase: client, userId: 'user-1', author: 'user', messageId: 'message-1' }))
      .resolves.toMatchObject({ ok: true, message: { attachment: null, deletedAt: '2026-11-21T09:06:00+00:00' } });
    expect(photos.removeSupportPhotoCopies).toHaveBeenCalledWith(client, [stored.path, stored.previewPath]);
  });
});
