// @vitest-environment node
// Node's own fetch types: a photo reply's form is built and read as the route's runtime does.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getAdminSupportThread, postAdminSupportAction } from '@/lib/admin-support-route-adapter-service';

const CONVERSATION_ID = '6f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const MESSAGE_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

const staffMessage = {
  id: MESSAGE_ID,
  author: 'staff' as const,
  clientMessageId: null,
  body: 'Done.',
  createdAt: '2026-11-21T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  attachment: null,
};

function signedIn(authenticated = true) {
  return vi.fn(async () => (authenticated
    ? { authenticated: true as const, identity: { subject: 'admin', username: 'admin', reviewerUserId: 'reviewer-1' } }
    : { authenticated: false as const, reason: 'missing' as const })) as never;
}

function consoleWith({ authenticated = true, owner = { id: CONVERSATION_ID, userId: 'account-1', status: 'open' as const } as unknown } = {}) {
  const dependencies = {
    authenticateAdminRequest: signedIn(authenticated),
    createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    getAdminSupportConversation: vi.fn(async () => ({
      conversation: { id: CONVERSATION_ID, userId: 'account-1', username: 'asha', displayName: 'Asha' },
      summary: { id: CONVERSATION_ID, status: 'open', userLastReadAt: null, staffLastReadAt: null, userTyping: true, staffTyping: false },
      messages: [staffMessage],
    }) as never),
    loadSupportConversationOwner: vi.fn(async () => owner as never),
    replyToSupportConversation: vi.fn(async () => ({
      ok: true as const,
      created: true,
      message: staffMessage,
      conversation: { id: CONVERSATION_ID, status: 'open' as const },
    })),
    setSupportConversationStatus: vi.fn(async () => ({ ok: true as const })),
    markSupportConversationRead: vi.fn(async () => ({ ok: true as const, userLastReadAt: null, staffLastReadAt: '2026-11-21T10:05:00.000Z' })),
    setSupportConversationTyping: vi.fn(async () => ({ ok: true })),
    editSupportMessage: vi.fn(async () => ({ ok: true as const, message: { ...staffMessage, body: 'Done!', editedAt: '2026-11-21T10:02:00.000Z' } })),
    deleteSupportMessage: vi.fn(async () => ({ ok: true as const, message: { ...staffMessage, body: null, deletedAt: '2026-11-21T10:03:00.000Z' } })),
    setSupportMessageReaction: vi.fn(async () => ({ ok: true as const, message: staffMessage })),
  };
  const post = (body: unknown) => postAdminSupportAction(new Request('https://magicbooklet.test/api/admin/support', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), dependencies);
  const get = (query: string) => getAdminSupportThread(new Request(`https://magicbooklet.test/api/admin/support${query}`), dependencies);
  const postForm = (fields: Record<string, string | Blob>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return postAdminSupportAction(new Request('https://magicbooklet.test/api/admin/support', { method: 'POST', body: form }), dependencies);
  };
  return { post, get, postForm, ...dependencies };
}

describe('GET /api/admin/support', () => {
  it('reads one thread for the console, with the account and the clients\' summary', async () => {
    const { get } = consoleWith();
    const response = await get(`?conversationId=${CONVERSATION_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      conversation: {
        id: CONVERSATION_ID,
        status: 'open',
        userLastReadAt: null,
        staffLastReadAt: null,
        userTyping: true,
        staffTyping: false,
        userId: 'account-1',
        username: 'asha',
        displayName: 'Asha',
      },
      messages: [staffMessage],
    });
  });

  it('refuses without the operator\'s session, and asks for a conversation id', async () => {
    const signedOut = consoleWith({ authenticated: false });
    expect((await signedOut.get(`?conversationId=${CONVERSATION_ID}`)).status).toBe(401);
    expect(signedOut.getAdminSupportConversation).not.toHaveBeenCalled();
    expect((await consoleWith().get('?conversationId=nope')).status).toBe(400);
  });

  it('answers a conversation that is gone 404', async () => {
    const gone = consoleWith();
    gone.getAdminSupportConversation.mockResolvedValueOnce(null as never);
    expect((await gone.get(`?conversationId=${CONVERSATION_ID}`)).status).toBe(404);
  });
});

describe('POST /api/admin/support', () => {
  it('refuses without the operator\'s session, doing nothing', async () => {
    const { post, replyToSupportConversation } = consoleWith({ authenticated: false });
    const response = await post({ action: 'reply', conversationId: CONVERSATION_ID, body: 'Hi' });
    expect(response.status).toBe(401);
    expect(replyToSupportConversation).not.toHaveBeenCalled();
  });

  it('replies with the operator\'s words, its retry id and the message it quotes', async () => {
    const { post, replyToSupportConversation } = consoleWith();
    const response = await post({
      action: 'reply',
      conversationId: CONVERSATION_ID,
      body: 'Done.',
      clientMessageId: 'msg:reply-0001',
      replyToMessageId: MESSAGE_ID,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, message: staffMessage });
    expect(replyToSupportConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: CONVERSATION_ID,
      body: 'Done.',
      clientMessageId: 'msg:reply-0001',
      replyToMessageId: MESSAGE_ID,
    }));
  });

  it('refuses a quote that is not a message id', async () => {
    const { post, replyToSupportConversation } = consoleWith();
    const response = await post({ action: 'reply', conversationId: CONVERSATION_ID, body: 'Done.', replyToMessageId: 'x' });
    expect(response.status).toBe(400);
    expect(replyToSupportConversation).not.toHaveBeenCalled();
  });

  it('resolves and reopens', async () => {
    const { post, setSupportConversationStatus } = consoleWith();
    await post({ action: 'resolve', conversationId: CONVERSATION_ID });
    await post({ action: 'reopen', conversationId: CONVERSATION_ID });
    const calls = setSupportConversationStatus.mock.calls as unknown as Array<[{ status: string }]>;
    expect(calls.map(([args]) => args.status)).toEqual(['resolved', 'open']);
  });

  it('holds a resolve to the account\'s latest message the operator was shown, and says when a newer one came', async () => {
    const { post, setSupportConversationStatus } = consoleWith();
    await post({ action: 'resolve', conversationId: CONVERSATION_ID, seenLastUserMessageAt: '2026-11-21T09:58:00.123456+00:00' });
    expect(setSupportConversationStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'resolved',
      seenLastUserMessageAt: '2026-11-21T09:58:00.123456+00:00',
    }));
    // A reopen is never held to it.
    await post({ action: 'reopen', conversationId: CONVERSATION_ID, seenLastUserMessageAt: '2026-11-21T09:58:00Z' });
    expect(setSupportConversationStatus).toHaveBeenLastCalledWith(expect.not.objectContaining({ seenLastUserMessageAt: expect.anything() }));

    setSupportConversationStatus.mockResolvedValueOnce({ ok: false, code: 'CONVERSATION_CHANGED', error: 'A new message came in. Read it, then resolve.' } as never);
    const changed = await post({ action: 'resolve', conversationId: CONVERSATION_ID, seenLastUserMessageAt: null });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toEqual({ error: 'A new message came in. Read it, then resolve.', code: 'CONVERSATION_CHANGED' });
  });

  it('reads and types as support, in the account\'s conversation', async () => {
    const { post, markSupportConversationRead, setSupportConversationTyping } = consoleWith();
    const read = await post({ action: 'read', conversationId: CONVERSATION_ID });
    await expect(read.json()).resolves.toEqual({ success: true, userLastReadAt: null, staffLastReadAt: '2026-11-21T10:05:00.000Z' });
    expect(markSupportConversationRead).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', reader: 'staff', upToMessageId: null }));
    await post({ action: 'read', conversationId: CONVERSATION_ID, upToMessageId: MESSAGE_ID });
    expect(markSupportConversationRead).toHaveBeenLastCalledWith(expect.objectContaining({ upToMessageId: MESSAGE_ID }));

    await post({ action: 'typing', conversationId: CONVERSATION_ID, typing: true });
    expect(setSupportConversationTyping).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', author: 'staff', typing: true }));
  });

  it('edits, deletes and reacts as support', async () => {
    const { post, editSupportMessage, deleteSupportMessage, setSupportMessageReaction } = consoleWith();
    expect((await post({ action: 'edit', conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, body: 'Done!' })).status).toBe(200);
    expect(editSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', author: 'staff', messageId: MESSAGE_ID, body: 'Done!' }));
    expect((await post({ action: 'delete', conversationId: CONVERSATION_ID, messageId: MESSAGE_ID })).status).toBe(200);
    expect(deleteSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ author: 'staff', messageId: MESSAGE_ID }));
    expect((await post({ action: 'react', conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, emoji: '👍' })).status).toBe(200);
    expect(setSupportMessageReaction).toHaveBeenCalledWith(expect.objectContaining({ author: 'staff', emoji: '👍' }));
  });

  it('answers a refusal with its status, and a missing message id 404', async () => {
    const late = consoleWith();
    late.editSupportMessage.mockResolvedValueOnce({ ok: false, code: 'EDIT_TOO_LATE', error: 'A message can be edited for 15 minutes after it is sent.' } as never);
    const response = await late.post({ action: 'edit', conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, body: 'x' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'A message can be edited for 15 minutes after it is sent.', code: 'EDIT_TOO_LATE' });

    const noId = await consoleWith().post({ action: 'delete', conversationId: CONVERSATION_ID });
    expect(noId.status).toBe(404);
  });

  it('answers an action in a conversation that is gone 404, and refuses an unknown action', async () => {
    const gone = consoleWith({ owner: null });
    expect((await gone.post({ action: 'read', conversationId: CONVERSATION_ID })).status).toBe(404);
    expect(gone.markSupportConversationRead).not.toHaveBeenCalled();
    expect((await consoleWith().post({ action: 'archive', conversationId: CONVERSATION_ID })).status).toBe(400);
    expect((await consoleWith().post({ action: 'reply', conversationId: 'not-an-id', body: 'x' })).status).toBe(400);
  });

  it('answers a fault 500 without its detail', async () => {
    const broken = consoleWith();
    broken.replyToSupportConversation.mockRejectedValueOnce(new Error('connection reset'));
    const response = await broken.post({ action: 'reply', conversationId: CONVERSATION_ID, body: 'x' });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'The support action failed. Try again.' });
  });
});

describe('POST /api/admin/support with a photo', () => {
  const picture = (bytes: number) => new Blob([new Uint8Array(bytes).fill(7)], { type: 'image/jpeg' });

  it('replies with the photo\'s bytes and the text as its caption', async () => {
    const { postForm, replyToSupportConversation } = consoleWith();
    const response = await postForm({
      action: 'reply',
      conversationId: CONVERSATION_ID,
      body: 'Here it is',
      clientMessageId: 'msg:photo-0001',
      replyToMessageId: MESSAGE_ID,
      photo: picture(2048),
    });
    expect(response.status).toBe(200);
    const [args] = replyToSupportConversation.mock.calls[0] as unknown as [{ photoBytes: Uint8Array; body: string; clientMessageId: string; replyToMessageId: string }];
    expect(args).toMatchObject({ body: 'Here it is', clientMessageId: 'msg:photo-0001', replyToMessageId: MESSAGE_ID });
    expect(args.photoBytes).toBeInstanceOf(Uint8Array);
    expect(args.photoBytes.byteLength).toBe(2048);
  });

  it('refuses a photo over the console\'s cap, an empty one, and one on anything but a reply', async () => {
    const { postForm, replyToSupportConversation, editSupportMessage } = consoleWith();
    const large = await postForm({ action: 'reply', conversationId: CONVERSATION_ID, body: '', photo: picture(4 * 1024 * 1024 + 1) });
    expect(large.status).toBe(413);
    await expect(large.json()).resolves.toMatchObject({ code: 'PHOTO_TOO_LARGE' });

    const empty = await postForm({ action: 'reply', conversationId: CONVERSATION_ID, body: 'x', photo: picture(0) });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ code: 'PHOTO_UNREADABLE' });

    const edit = await postForm({ action: 'edit', conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, body: 'x', photo: picture(10) });
    expect(edit.status).toBe(400);
    expect(replyToSupportConversation).not.toHaveBeenCalled();
    expect(editSupportMessage).not.toHaveBeenCalled();
  });
});
