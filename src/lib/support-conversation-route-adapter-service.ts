import 'server-only';

import { NextResponse } from 'next/server';

import { isGuestUser } from '@/lib/account-identity';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  SUPPORT_ACTION_RATE_LIMIT,
  SUPPORT_MESSAGE_RATE_LIMIT,
  SUPPORT_SIGNAL_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  deleteSupportMessage,
  editSupportMessage,
  getSupportConversation,
  markSupportConversationRead,
  sendSupportMessage,
  setSupportConversationTyping,
  setSupportMessageReaction,
  supportRefusalStatus,
} from '@/lib/support-conversations';

import {
  SUPPORT_CLIENT_MESSAGE_ID_INVALID,
  SUPPORT_REFUSAL_WORDS,
  checkSupportMessage,
  isSupportClientMessageId,
  isSupportMessageId,
  isSupportReactionEmoji,
  readSupportPhotoRequest,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * The account's side of its conversation with support. Registered accounts
 * only (route-identity-policy.ts); a guest's token is refused at the proxy and
 * again here. Every write is the caller's own: the routes never take an
 * account or an author from the request.
 *
 * - `GET /api/support/conversation`: the conversation (or none yet).
 * - `POST /api/support/conversation`: a message, opening the conversation on
 *   the first one; `replyToMessageId` quotes a message, and `photo` names a
 *   picture the account staged in `uploads`, which the send claims.
 * - `POST /api/support/conversation/read`: the account read the thread.
 * - `POST /api/support/conversation/typing`: the account is typing.
 * - `PATCH` / `DELETE /api/support/messages/:messageId`: edit one's own
 *   message (15 minutes) or delete it for everyone (48 hours).
 * - `POST /api/support/messages/:messageId/reaction`: set or clear one's reaction.
 */

// A message is at most 2,000 characters; JSON escaping can grow one to six
// bytes. Anything past this is not a message.
const SUPPORT_MESSAGE_BODY_MAX_BYTES = 16 * 1024;
const SUPPORT_SMALL_BODY_MAX_BYTES = 1024;

type SupportConversationRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getSupportConversation?: typeof getSupportConversation;
  sendSupportMessage?: typeof sendSupportMessage;
  editSupportMessage?: typeof editSupportMessage;
  deleteSupportMessage?: typeof deleteSupportMessage;
  setSupportMessageReaction?: typeof setSupportMessageReaction;
  markSupportConversationRead?: typeof markSupportConversationRead;
  setSupportConversationTyping?: typeof setSupportConversationTyping;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: SupportConversationRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getSupportConversation: dependencies?.getSupportConversation ?? getSupportConversation,
    sendSupportMessage: dependencies?.sendSupportMessage ?? sendSupportMessage,
    editSupportMessage: dependencies?.editSupportMessage ?? editSupportMessage,
    deleteSupportMessage: dependencies?.deleteSupportMessage ?? deleteSupportMessage,
    setSupportMessageReaction: dependencies?.setSupportMessageReaction ?? setSupportMessageReaction,
    markSupportConversationRead: dependencies?.markSupportConversationRead ?? markSupportConversationRead,
    setSupportConversationTyping: dependencies?.setSupportConversationTyping ?? setSupportConversationTyping,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

type Resolved = ReturnType<typeof resolveDependencies>;
type MessageRouteContext = { params: Promise<{ messageId: string }> };

async function authenticate(request: Request, dependencies: Resolved) {
  const supabase = dependencies.createUserClient(request);
  const { data: { user }, error } = await getVerifiedAuthUserResult(supabase);
  // A guest holds a valid token but no account to keep a conversation with.
  return error || !user || isGuestUser(user) ? null : user;
}

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

async function readObjectBody(request: Request, dependencies: Resolved, maxBytes: number) {
  const bodyResult = await dependencies.readBoundedJsonBody(request, maxBytes);
  if (!bodyResult.ok) {
    return {
      ok: false as const,
      response: bodyResult.reason === 'too_large'
        ? NextResponse.json({ error: 'That message is too long.', code: 'MESSAGE_TOO_LONG' }, { status: 413 })
        : NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }),
    };
  }
  const value = bodyResult.value;
  return {
    ok: true as const,
    body: (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>,
  };
}

async function limit(
  adminSupabase: ReturnType<Resolved['createServiceClient']>,
  dependencies: Resolved,
  rule: typeof SUPPORT_MESSAGE_RATE_LIMIT | typeof SUPPORT_ACTION_RATE_LIMIT | typeof SUPPORT_SIGNAL_RATE_LIMIT,
  key: string,
  failure: string,
): Promise<NextResponse | null> {
  try {
    await dependencies.enforceBackendRateLimit(adminSupabase, { ...rule, key });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    dependencies.logError(`Failed to enforce the ${rule.scope} rate limit:`, error);
    return NextResponse.json({ error: failure }, { status: 500 });
  }
}

async function handleGET(request: Request, dependencies: Resolved) {
  const user = await authenticate(request, dependencies);
  if (!user) return unauthorized();

  try {
    const { conversation, messages } = await dependencies.getSupportConversation({
      adminSupabase: dependencies.createServiceClient(),
      userId: user.id,
    });
    return NextResponse.json({ success: true, conversation, messages });
  } catch (error) {
    dependencies.logError('Failed to load the support conversation:', error);
    return NextResponse.json({ error: 'Failed to load your messages.' }, { status: 500 });
  }
}

async function handleSend(request: Request, dependencies: Resolved) {
  const user = await authenticate(request, dependencies);
  if (!user) return unauthorized();

  const parsed = await readObjectBody(request, dependencies, SUPPORT_MESSAGE_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!isSupportClientMessageId(body.clientMessageId)) {
    return NextResponse.json(
      { error: SUPPORT_CLIENT_MESSAGE_ID_INVALID, code: 'INVALID_CLIENT_MESSAGE_ID' },
      { status: 400 },
    );
  }

  const replyToMessageId = body.replyToMessageId ?? null;
  if (replyToMessageId !== null && !isSupportMessageId(replyToMessageId)) {
    return NextResponse.json(
      { error: SUPPORT_REFUSAL_WORDS.REPLY_NOT_FOUND, code: 'REPLY_NOT_FOUND' },
      { status: 400 },
    );
  }

  // A photo is named by the path its staged upload answered with, inside the
  // account's own folder of `uploads` (the claim checks the owner again).
  const hasPhotoField = body.photo !== undefined && body.photo !== null;
  const photo = hasPhotoField ? readSupportPhotoRequest(body.photo) : null;
  if (hasPhotoField && (!photo || !photo.storagePath.startsWith(`uploads/${user.id}/`))) {
    return NextResponse.json(
      { error: SUPPORT_REFUSAL_WORDS.PHOTO_NOT_FOUND, code: 'PHOTO_NOT_FOUND' },
      { status: 409 },
    );
  }

  // Refused before the rate limit, so a message that cannot be sent spends
  // nothing. sendSupportMessage holds the text to the same rule again.
  const checked = checkSupportMessage(body.body, { hasPhoto: photo !== null });
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
  }

  const adminSupabase = dependencies.createServiceClient();
  const limited = await limit(adminSupabase, dependencies, SUPPORT_MESSAGE_RATE_LIMIT, user.id, 'Failed to send your message.');
  if (limited) return limited;

  try {
    const result = await dependencies.sendSupportMessage({
      adminSupabase,
      // Always the caller: an account writes only in its own conversation.
      userId: user.id,
      author: 'user',
      body: checked.body,
      clientMessageId: body.clientMessageId,
      replyToMessageId,
      photo: photo ? { kind: 'staged', storagePath: photo.storagePath } : null,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: supportRefusalStatus(result.code) });
    }

    return NextResponse.json({
      success: true,
      message: result.message,
      conversation: result.conversation,
    });
  } catch (error) {
    dependencies.logError('Failed to send a support message:', error);
    return NextResponse.json({ error: 'Failed to send your message.' }, { status: 500 });
  }
}

async function handleRead(request: Request, dependencies: Resolved) {
  const user = await authenticate(request, dependencies);
  if (!user) return unauthorized();

  const adminSupabase = dependencies.createServiceClient();
  const limited = await limit(adminSupabase, dependencies, SUPPORT_SIGNAL_RATE_LIMIT, user.id, 'Failed to mark your messages read.');
  if (limited) return limited;

  // How far the reader has read: the newest message it was shown. An app from
  // before 2026-11-23 sends no body, and reads the whole thread as it did then.
  let upToMessageId: string | null = null;
  if (request.body) {
    const bodyResult = await dependencies.readBoundedJsonBody(request, SUPPORT_SMALL_BODY_MAX_BYTES);
    if (!bodyResult.ok && bodyResult.reason === 'too_large') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 413 });
    }
    const value = bodyResult.ok && bodyResult.value && typeof bodyResult.value === 'object'
      ? (bodyResult.value as Record<string, unknown>).upToMessageId
      : undefined;
    if (isSupportMessageId(value)) upToMessageId = value;
  }

  try {
    const result = await dependencies.markSupportConversationRead({ adminSupabase, userId: user.id, reader: 'user', upToMessageId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      userLastReadAt: result.userLastReadAt,
      staffLastReadAt: result.staffLastReadAt,
    });
  } catch (error) {
    dependencies.logError('Failed to mark a support conversation read:', error);
    return NextResponse.json({ error: 'Failed to mark your messages read.' }, { status: 500 });
  }
}

async function handleTyping(request: Request, dependencies: Resolved) {
  const user = await authenticate(request, dependencies);
  if (!user) return unauthorized();

  const parsed = await readObjectBody(request, dependencies, SUPPORT_SMALL_BODY_MAX_BYTES);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.body.typing !== 'boolean') {
    return NextResponse.json({ error: 'typing must be true or false.' }, { status: 400 });
  }

  const adminSupabase = dependencies.createServiceClient();
  const limited = await limit(adminSupabase, dependencies, SUPPORT_SIGNAL_RATE_LIMIT, user.id, 'Failed to update typing.');
  if (limited) return limited;

  try {
    // Before the first message there is no conversation and no-one to tell:
    // answered the same, since the composer has nothing to do about it.
    await dependencies.setSupportConversationTyping({
      adminSupabase,
      userId: user.id,
      author: 'user',
      typing: parsed.body.typing,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    dependencies.logError('Failed to update support typing:', error);
    return NextResponse.json({ error: 'Failed to update typing.' }, { status: 500 });
  }
}

async function readMessageId(context: MessageRouteContext): Promise<string | null> {
  const { messageId } = await context.params;
  return isSupportMessageId(messageId) ? messageId : null;
}

function messageNotFound() {
  return NextResponse.json(
    { error: SUPPORT_REFUSAL_WORDS.MESSAGE_NOT_FOUND, code: 'MESSAGE_NOT_FOUND' },
    { status: 404 },
  );
}

type MessageChange =
  | { kind: 'edit'; body: unknown }
  | { kind: 'delete' }
  | { kind: 'react'; emoji: unknown };

async function handleMessageChange(
  request: Request,
  context: MessageRouteContext,
  dependencies: Resolved,
  readChange: (body: Record<string, unknown>) => MessageChange | NextResponse,
  needsBody: boolean,
) {
  const user = await authenticate(request, dependencies);
  if (!user) return unauthorized();

  const messageId = await readMessageId(context);
  if (!messageId) return messageNotFound();

  let change: MessageChange | NextResponse = { kind: 'delete' };
  if (needsBody) {
    const parsed = await readObjectBody(request, dependencies, SUPPORT_MESSAGE_BODY_MAX_BYTES);
    if (!parsed.ok) return parsed.response;
    change = readChange(parsed.body);
    if (change instanceof NextResponse) return change;
  }

  const adminSupabase = dependencies.createServiceClient();
  const limited = await limit(adminSupabase, dependencies, SUPPORT_ACTION_RATE_LIMIT, user.id, 'That did not go through.');
  if (limited) return limited;

  try {
    const shared = { adminSupabase, userId: user.id, author: 'user' as const, messageId };
    const result = change.kind === 'edit'
      ? await dependencies.editSupportMessage({ ...shared, body: change.body })
      : change.kind === 'react'
        ? await dependencies.setSupportMessageReaction({ ...shared, emoji: change.emoji })
        : await dependencies.deleteSupportMessage(shared);

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: supportRefusalStatus(result.code) });
    }
    return NextResponse.json({ success: true, message: result.message });
  } catch (error) {
    dependencies.logError(`Failed to ${change.kind} a support message:`, error);
    return NextResponse.json({ error: 'That did not go through. Try again.' }, { status: 500 });
  }
}

function readEdit(body: Record<string, unknown>): MessageChange | NextResponse {
  const checked = checkSupportMessage(body.body);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
  }
  return { kind: 'edit', body: checked.body };
}

function readReaction(body: Record<string, unknown>): MessageChange | NextResponse {
  const emoji = body.emoji ?? null;
  if (emoji !== null && !isSupportReactionEmoji(emoji)) {
    return NextResponse.json(
      { error: SUPPORT_REFUSAL_WORDS.INVALID_REACTION, code: 'INVALID_REACTION' },
      { status: 400 },
    );
  }
  return { kind: 'react', emoji };
}

export function createSupportConversationRouteHandlers({
  dependencies,
}: {
  dependencies?: SupportConversationRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);

  return {
    async GET(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handleGET(request, resolved), request);
    },
    async POST(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handleSend(request, resolved), request);
    },
  };
}

export function createSupportConversationReadRouteHandlers({
  dependencies,
}: {
  dependencies?: SupportConversationRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async POST(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handleRead(request, resolved), request);
    },
  };
}

export function createSupportConversationTypingRouteHandlers({
  dependencies,
}: {
  dependencies?: SupportConversationRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async POST(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handleTyping(request, resolved), request);
    },
  };
}

export function createSupportMessageRouteHandlers({
  dependencies,
}: {
  dependencies?: SupportConversationRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async PATCH(request: Request, context: MessageRouteContext) {
      return applyPrivateNoStoreApiResponseHeaders(
        await handleMessageChange(request, context, resolved, readEdit, true),
        request,
      );
    },
    async DELETE(request: Request, context: MessageRouteContext) {
      return applyPrivateNoStoreApiResponseHeaders(
        await handleMessageChange(request, context, resolved, () => ({ kind: 'delete' }), false),
        request,
      );
    },
  };
}

export function createSupportMessageReactionRouteHandlers({
  dependencies,
}: {
  dependencies?: SupportConversationRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);
  return {
    async POST(request: Request, context: MessageRouteContext) {
      return applyPrivateNoStoreApiResponseHeaders(
        await handleMessageChange(request, context, resolved, readReaction, true),
        request,
      );
    },
  };
}
