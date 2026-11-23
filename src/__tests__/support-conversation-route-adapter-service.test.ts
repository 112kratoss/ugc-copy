import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const authUser = vi.hoisted(() => ({
  value: { id: 'account-1', is_anonymous: false } as { id: string; is_anonymous: boolean } | null,
}));

vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({ data: { user: authUser.value }, error: null })),
}));

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createSupportConversationReadRouteHandlers,
  createSupportConversationRouteHandlers,
  createSupportConversationTypingRouteHandlers,
  createSupportMessageReactionRouteHandlers,
  createSupportMessageRouteHandlers,
} from '@/lib/support-conversation-route-adapter-service';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const endpoints = mobileApiContract.endpoints;
const BASE = 'https://magicbooklet.test';
const MESSAGE_ID = '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a';

function dependencies({ rateLimit = vi.fn(async () => undefined as never) } = {}) {
  return {
    createUserClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    enforceBackendRateLimit: rateLimit,
    getSupportConversation: vi.fn(async () => ({
      conversation: endpoints.getSupportConversation.response.conversation,
      messages: endpoints.getSupportConversation.response.messages,
    }) as never),
    sendSupportMessage: vi.fn(async () => ({
      ok: true as const,
      created: true,
      message: endpoints.sendSupportMessage.response.message as never,
      conversation: endpoints.sendSupportMessage.response.conversation as never,
    })),
    editSupportMessage: vi.fn(async () => ({ ok: true as const, message: endpoints.editSupportMessage.response.message as never })),
    deleteSupportMessage: vi.fn(async () => ({ ok: true as const, message: endpoints.deleteSupportMessage.response.message as never })),
    setSupportMessageReaction: vi.fn(async () => ({ ok: true as const, message: endpoints.reactToSupportMessage.response.message as never })),
    markSupportConversationRead: vi.fn(async () => ({
      ok: true as const,
      userLastReadAt: endpoints.markSupportConversationRead.response.userLastReadAt,
      staffLastReadAt: endpoints.markSupportConversationRead.response.staffLastReadAt,
    })),
    setSupportConversationTyping: vi.fn(async () => ({ ok: true })),
    logError: vi.fn(),
  };
}

function jsonRequest(path: string, method: string, body?: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const messageContext = (messageId = MESSAGE_ID) => ({ params: Promise.resolve({ messageId }) });

const rateLimited = () => vi.fn(async () => {
  throw new BackendRateLimitError({ scope: 'support:message', limit: 20, remaining: 0, resetAt: '2026-11-21T10:00:00.000Z', retryAfterSeconds: 60 } as never);
});

beforeEach(() => {
  authUser.value = { id: 'account-1', is_anonymous: false };
});

describe('GET /api/support/conversation', () => {
  it('reads the caller\'s own conversation, never cached', async () => {
    const deps = dependencies();
    const response = await createSupportConversationRouteHandlers({ dependencies: deps }).GET(jsonRequest('/api/support/conversation', 'GET'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual(endpoints.getSupportConversation.response);
    expect(deps.getSupportConversation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1' }));
  });

  it.each([
    ['a guest', { id: 'guest-1', is_anonymous: true }],
    ['no one', null],
  ])('refuses %s', async (_label, user) => {
    authUser.value = user;
    const deps = dependencies();
    const response = await createSupportConversationRouteHandlers({ dependencies: deps }).GET(jsonRequest('/api/support/conversation', 'GET'));
    expect(response.status).toBe(401);
    expect(deps.getSupportConversation).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/conversation', () => {
  const send = (body: unknown, deps = dependencies()) => ({
    deps,
    response: createSupportConversationRouteHandlers({ dependencies: deps }).POST(jsonRequest('/api/support/conversation', 'POST', body)),
  });

  it('sends the caller\'s message as the account, quoting the message it replies to', async () => {
    const { deps, response } = send(endpoints.sendSupportMessage.request);
    expect((await response).status).toBe(200);
    await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.response);
    expect(deps.sendSupportMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'account-1',
      author: 'user',
      body: endpoints.sendSupportMessage.request.body,
      clientMessageId: endpoints.sendSupportMessage.request.clientMessageId,
      replyToMessageId: endpoints.sendSupportMessage.request.replyToMessageId,
    }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'support:message', key: 'account-1' }));
  });

  it('refuses a reply to something that is not a message id, before the rate limit', async () => {
    const { deps, response } = send({ ...endpoints.sendSupportMessage.request, replyToMessageId: '../../admin' });
    expect((await response).status).toBe(400);
    await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors.replyNotFound.response);
    expect(deps.enforceBackendRateLimit).not.toHaveBeenCalled();
  });

  it('refuses an empty message and a bad client id with the contract\'s words, spending nothing', async () => {
    const empty = send({ body: '  ', clientMessageId: 'msg:0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' });
    expect((await empty.response).status).toBe(400);
    await expect((await empty.response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors.emptyMessage.response);
    expect(empty.deps.enforceBackendRateLimit).not.toHaveBeenCalled();

    const badId = send({ body: 'Hello', clientMessageId: 'x' });
    await expect((await badId.response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors.invalidClientMessageId.response);
  });

  it('answers the service\'s refusal of a quoted message that is gone', async () => {
    const deps = dependencies();
    deps.sendSupportMessage.mockResolvedValueOnce({
      ok: false,
      code: 'REPLY_NOT_FOUND',
      error: endpoints.sendSupportMessage.errors.replyNotFound.response.error,
    } as never);
    const { response } = send(endpoints.sendSupportMessage.request, deps);
    expect((await response).status).toBe(400);
    await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors.replyNotFound.response);
  });

  it('sends a staged photo by its path, with an empty caption', async () => {
    const deps = dependencies();
    deps.sendSupportMessage.mockResolvedValueOnce({
      ok: true,
      created: true,
      message: endpoints.sendSupportMessage.responseVariants.photo.message as never,
      conversation: endpoints.sendSupportMessage.responseVariants.photo.conversation as never,
    });
    authUser.value = { id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b', is_anonymous: false };
    const { response } = send(endpoints.sendSupportMessage.requestVariants.photo, deps);
    expect((await response).status).toBe(200);
    await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.responseVariants.photo);
    expect(deps.sendSupportMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: '',
      photo: { kind: 'staged', storagePath: endpoints.sendSupportMessage.requestVariants.photo.photo.storagePath },
    }));
  });

  it('refuses a photo outside the caller\'s own folder of uploads before anything is claimed', async () => {
    for (const storagePath of ['uploads/someone-else/a.jpg', 'support_attachments/account-1/a.webp', 'uploads/account-1/../x.jpg']) {
      const { deps, response } = send({ body: '', clientMessageId: 'msg:0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', photo: { storagePath } });
      expect((await response).status).toBe(409);
      await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors.photoNotFound.response);
      expect(deps.sendSupportMessage).not.toHaveBeenCalled();
      expect(deps.enforceBackendRateLimit).not.toHaveBeenCalled();
    }
  });

  it('answers the service\'s refusals of a photo with the contract\'s words', async () => {
    for (const [code, key] of [['PHOTO_UNREADABLE', 'photoUnreadable'], ['PHOTO_TOO_LARGE', 'photoTooLarge'], ['PHOTO_NOT_FOUND', 'photoNotFound']] as const) {
      const deps = dependencies();
      deps.sendSupportMessage.mockResolvedValueOnce({ ok: false, code, error: endpoints.sendSupportMessage.errors[key].response.error } as never);
      const { response } = send({ body: '', clientMessageId: 'msg:0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', photo: { storagePath: 'uploads/account-1/a.jpg' } }, deps);
      expect((await response).status).toBe(endpoints.sendSupportMessage.errors[key].status);
      await expect((await response).json()).resolves.toEqual(endpoints.sendSupportMessage.errors[key].response);
    }
  });

  it('answers a send over the limit 429 without writing', async () => {
    const deps = dependencies({ rateLimit: rateLimited() });
    const { response } = send(endpoints.sendSupportMessage.request, deps);
    expect((await response).status).toBe(429);
    expect(deps.sendSupportMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/conversation/read and /typing', () => {
  it('marks the caller\'s own conversation read', async () => {
    const deps = dependencies();
    const response = await createSupportConversationReadRouteHandlers({ dependencies: deps })
      .POST(jsonRequest('/api/support/conversation/read', 'POST'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoints.markSupportConversationRead.response);
    expect(deps.markSupportConversationRead).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', reader: 'user', upToMessageId: null }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'support:signal' }));
  });

  it('marks read up to the newest message the app drew, and takes an app\'s read with no body as before', async () => {
    const deps = dependencies();
    const handlers = createSupportConversationReadRouteHandlers({ dependencies: deps });
    expect((await handlers.POST(jsonRequest('/api/support/conversation/read', 'POST', { upToMessageId: MESSAGE_ID }))).status).toBe(200);
    expect(deps.markSupportConversationRead).toHaveBeenLastCalledWith(expect.objectContaining({ upToMessageId: MESSAGE_ID }));
    // Not a message id: the whole thread, never a refusal of the read.
    expect((await handlers.POST(jsonRequest('/api/support/conversation/read', 'POST', { upToMessageId: '../x' }))).status).toBe(200);
    expect(deps.markSupportConversationRead).toHaveBeenLastCalledWith(expect.objectContaining({ upToMessageId: null }));
    expect((await handlers.POST(jsonRequest('/api/support/conversation/read', 'POST'))).status).toBe(200);
    expect(deps.markSupportConversationRead).toHaveBeenLastCalledWith(expect.objectContaining({ upToMessageId: null }));
  });

  it('answers a read with no conversation 404', async () => {
    const deps = dependencies();
    deps.markSupportConversationRead.mockResolvedValueOnce({ ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'This conversation no longer exists.' } as never);
    const response = await createSupportConversationReadRouteHandlers({ dependencies: deps })
      .POST(jsonRequest('/api/support/conversation/read', 'POST'));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(endpoints.markSupportConversationRead.errors.noConversation.response);
  });

  it('says the caller is typing, and takes only true or false', async () => {
    const deps = dependencies();
    const handlers = createSupportConversationTypingRouteHandlers({ dependencies: deps });
    const response = await handlers.POST(jsonRequest('/api/support/conversation/typing', 'POST', endpoints.setSupportTyping.request));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoints.setSupportTyping.response);
    expect(deps.setSupportConversationTyping).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', author: 'user', typing: true }));

    const refused = await handlers.POST(jsonRequest('/api/support/conversation/typing', 'POST', { typing: 'yes' }));
    expect(refused.status).toBe(400);
  });
});

describe('PATCH and DELETE /api/support/messages/:messageId', () => {
  it('edits the caller\'s message as the account, trimmed', async () => {
    const deps = dependencies();
    const response = await createSupportMessageRouteHandlers({ dependencies: deps })
      .PATCH(jsonRequest(`/api/support/messages/${MESSAGE_ID}`, 'PATCH', { body: `  ${endpoints.editSupportMessage.request.body} ` }), messageContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoints.editSupportMessage.response);
    expect(deps.editSupportMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'account-1',
      author: 'user',
      messageId: MESSAGE_ID,
      body: endpoints.editSupportMessage.request.body,
    }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'support:action' }));
  });

  it.each([
    ['editTooLate', 'EDIT_TOO_LATE', 409],
    ['notYourMessage', 'NOT_YOUR_MESSAGE', 403],
    ['messageDeleted', 'MESSAGE_DELETED', 409],
    ['messageNotFound', 'MESSAGE_NOT_FOUND', 404],
  ] as const)('answers the %s refusal as the contract says', async (name, code, status) => {
    const deps = dependencies();
    deps.editSupportMessage.mockResolvedValueOnce({ ok: false, code, error: endpoints.editSupportMessage.errors[name].response.error } as never);
    const response = await createSupportMessageRouteHandlers({ dependencies: deps })
      .PATCH(jsonRequest(`/api/support/messages/${MESSAGE_ID}`, 'PATCH', endpoints.editSupportMessage.request), messageContext());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(endpoints.editSupportMessage.errors[name].response);
  });

  it('answers a path that is not a message id 404 without asking the service', async () => {
    const deps = dependencies();
    const response = await createSupportMessageRouteHandlers({ dependencies: deps })
      .DELETE(jsonRequest('/api/support/messages/not-an-id', 'DELETE'), messageContext('not-an-id'));
    expect(response.status).toBe(404);
    expect(deps.deleteSupportMessage).not.toHaveBeenCalled();
  });

  it('deletes the caller\'s message for everyone, as the account', async () => {
    const deps = dependencies();
    const response = await createSupportMessageRouteHandlers({ dependencies: deps })
      .DELETE(jsonRequest(`/api/support/messages/${MESSAGE_ID}`, 'DELETE'), messageContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoints.deleteSupportMessage.response);
    expect(deps.deleteSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', author: 'user', messageId: MESSAGE_ID }));
  });

  it('refuses a guest before anything else', async () => {
    authUser.value = { id: 'guest-1', is_anonymous: true };
    const deps = dependencies();
    const response = await createSupportMessageRouteHandlers({ dependencies: deps })
      .DELETE(jsonRequest(`/api/support/messages/${MESSAGE_ID}`, 'DELETE'), messageContext());
    expect(response.status).toBe(401);
    expect(deps.deleteSupportMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/support/messages/:messageId/reaction', () => {
  it('sets the caller\'s reaction, and passes null to take it away', async () => {
    const deps = dependencies();
    const handlers = createSupportMessageReactionRouteHandlers({ dependencies: deps });
    const response = await handlers.POST(
      jsonRequest(`/api/support/messages/${MESSAGE_ID}/reaction`, 'POST', endpoints.reactToSupportMessage.request),
      messageContext(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoints.reactToSupportMessage.response);
    expect(deps.setSupportMessageReaction).toHaveBeenCalledWith(expect.objectContaining({ author: 'user', emoji: '🙏' }));

    await handlers.POST(
      jsonRequest(`/api/support/messages/${MESSAGE_ID}/reaction`, 'POST', endpoints.reactToSupportMessage.requestVariants.remove),
      messageContext(),
    );
    expect(deps.setSupportMessageReaction).toHaveBeenLastCalledWith(expect.objectContaining({ emoji: null }));
  });

  it('refuses a reaction outside the quick set without asking the service', async () => {
    const deps = dependencies();
    const response = await createSupportMessageReactionRouteHandlers({ dependencies: deps })
      .POST(jsonRequest(`/api/support/messages/${MESSAGE_ID}/reaction`, 'POST', { emoji: '🤡' }), messageContext());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(endpoints.reactToSupportMessage.errors.invalidReaction.response);
    expect(deps.setSupportMessageReaction).not.toHaveBeenCalled();
  });
});
