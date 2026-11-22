import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import { getAdminSupportConversation } from '@/lib/admin-support-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import { createServiceClient } from '@/lib/server-helpers';
import {
  deleteSupportMessage,
  editSupportMessage,
  loadSupportConversationOwner,
  markSupportConversationRead,
  replyToSupportConversation,
  setSupportConversationStatus,
  setSupportConversationTyping,
  setSupportMessageReaction,
  supportRefusalStatus,
} from '@/lib/support-conversations';

import {
  SUPPORT_CONSOLE_PHOTO_MAX_BYTES,
  SUPPORT_REFUSAL_WORDS,
  isSupportClientMessageId,
  isSupportMessageId,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * `/api/admin/support`: the operator's side of a support conversation.
 *
 * - `GET ?conversationId=` reads the thread, which the console asks for again
 *   while it is open.
 * - `POST` takes an `action`: `reply` adds the operator's message (quoting one
 *   with `replyToMessageId`) and tells the account, and sent as multipart form
 *   data it carries a photo (`photo`, which the console has shrunk under the
 *   host's request cap) with the text as its caption; `resolve` and `reopen`
 *   switch its status; `read` and `typing` are the operator's receipts and
 *   "typing…"; `edit`, `delete` and `react` change support's own message or
 *   react to any.
 *
 * Like every admin decision, the session is checked here, not trusted from the
 * proxy.
 */

type ResponseHeaders = ReturnType<typeof createApiResponseHeaders>;

type SupportActionBody = {
  action?: unknown;
  conversationId?: unknown;
  messageId?: unknown;
  body?: unknown;
  clientMessageId?: unknown;
  replyToMessageId?: unknown;
  emoji?: unknown;
  typing?: unknown;
};

const SUPPORT_ACTIONS = ['reply', 'resolve', 'reopen', 'read', 'typing', 'edit', 'delete', 'react'] as const;
type SupportAction = (typeof SUPPORT_ACTIONS)[number];

function isSupportAction(value: unknown): value is SupportAction {
  return typeof value === 'string' && (SUPPORT_ACTIONS as readonly string[]).includes(value);
}

const CONSOLE_PHOTO_TOO_LARGE = 'That photo is too large to send from the console. Choose a smaller one.';
/** Room for the form's other fields and its boundaries around the photo. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

type ActionRequest =
  | { ok: true; body: SupportActionBody; photo: Uint8Array | null }
  | { ok: false; status: number; error: string; code?: string };

/** The action as JSON, or a photo reply as multipart form data. */
async function readActionRequest(request: Request): Promise<ActionRequest> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    try {
      const body = await request.json();
      return body && typeof body === 'object' && !Array.isArray(body)
        ? { ok: true, body: body as SupportActionBody, photo: null }
        : { ok: false, status: 400, error: 'Invalid request body.' };
    } catch {
      return { ok: false, status: 400, error: 'Invalid request body.' };
    }
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > SUPPORT_CONSOLE_PHOTO_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return { ok: false, status: 413, error: CONSOLE_PHOTO_TOO_LARGE, code: 'PHOTO_TOO_LARGE' };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, status: 400, error: 'Invalid request body.' };
  }

  // Read by its shape: the form's File may come from another realm than this
  // module's Blob (the platform's fetch under a test DOM, say).
  const entry = form.get('photo');
  const file = entry && typeof entry === 'object' && typeof (entry as Blob).arrayBuffer === 'function'
    ? entry as Blob
    : null;
  if (!file || file.size === 0) {
    return { ok: false, status: 400, error: SUPPORT_REFUSAL_WORDS.PHOTO_UNREADABLE, code: 'PHOTO_UNREADABLE' };
  }
  if (file.size > SUPPORT_CONSOLE_PHOTO_MAX_BYTES) {
    return { ok: false, status: 413, error: CONSOLE_PHOTO_TOO_LARGE, code: 'PHOTO_TOO_LARGE' };
  }

  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    ok: true,
    body: {
      action: field('action'),
      conversationId: field('conversationId'),
      body: field('body') ?? '',
      clientMessageId: field('clientMessageId'),
      replyToMessageId: field('replyToMessageId') || null,
    },
    photo: new Uint8Array(await file.arrayBuffer()),
  };
}

type AdminSupportRouteDependencies = {
  authenticateAdminRequest?: typeof authenticateAdminRequest;
  createServiceClient?: typeof createServiceClient;
  getAdminSupportConversation?: typeof getAdminSupportConversation;
  loadSupportConversationOwner?: typeof loadSupportConversationOwner;
  replyToSupportConversation?: typeof replyToSupportConversation;
  setSupportConversationStatus?: typeof setSupportConversationStatus;
  markSupportConversationRead?: typeof markSupportConversationRead;
  setSupportConversationTyping?: typeof setSupportConversationTyping;
  editSupportMessage?: typeof editSupportMessage;
  deleteSupportMessage?: typeof deleteSupportMessage;
  setSupportMessageReaction?: typeof setSupportMessageReaction;
};

async function admit(request: Request, dependencies: AdminSupportRouteDependencies, headers: ResponseHeaders) {
  const auth = await (dependencies.authenticateAdminRequest ?? authenticateAdminRequest)(request);
  if (auth.authenticated) return null;
  return NextResponse.json(
    { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
    { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
  );
}

function conversationNotFound(headers: ResponseHeaders) {
  return NextResponse.json(
    { error: 'This conversation no longer exists.', code: 'CONVERSATION_NOT_FOUND' },
    { status: 404, headers },
  );
}

function logFailure(request: Request, msg: string, action: unknown, error: unknown) {
  logBackendRouteError(JSON.stringify({
    level: 'error',
    msg,
    requestId: getApiRequestId(request),
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
}

export async function getAdminSupportThread(
  request: Request,
  dependencies: AdminSupportRouteDependencies = {},
): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const refused = await admit(request, dependencies, headers);
  if (refused) return refused;

  const conversationId = new URL(request.url).searchParams.get('conversationId');
  if (!isSupportMessageId(conversationId)) {
    return NextResponse.json({ error: 'A conversation id is required.' }, { status: 400, headers });
  }

  try {
    const thread = await (dependencies.getAdminSupportConversation ?? getAdminSupportConversation)(
      (dependencies.createServiceClient ?? createServiceClient)(),
      conversationId,
    );
    if (!thread) return conversationNotFound(headers);

    return NextResponse.json({
      success: true,
      conversation: {
        ...thread.summary,
        userId: thread.conversation.userId,
        username: thread.conversation.username,
        displayName: thread.conversation.displayName,
      },
      messages: thread.messages,
    }, { headers });
  } catch (error) {
    logFailure(request, 'admin_support_thread_failed', 'read-thread', error);
    return NextResponse.json({ error: 'The conversation could not be loaded. Try again.' }, { status: 500, headers });
  }
}

export async function postAdminSupportAction(
  request: Request,
  dependencies: AdminSupportRouteDependencies = {},
): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const refused = await admit(request, dependencies, headers);
  if (refused) return refused;

  const parsed = await readActionRequest(request);
  if (!parsed.ok) {
    return NextResponse.json(
      parsed.code ? { error: parsed.error, code: parsed.code } : { error: parsed.error },
      { status: parsed.status, headers },
    );
  }
  const { body, photo } = parsed;

  if (!isSupportMessageId(body.conversationId)) {
    return NextResponse.json({ error: 'A conversation id is required.' }, { status: 400, headers });
  }

  if (!isSupportAction(body.action)) {
    return NextResponse.json({ error: 'Unsupported support action.' }, { status: 400, headers });
  }

  const action = body.action;
  const conversationId = body.conversationId;
  if (photo && action !== 'reply') {
    return NextResponse.json({ error: 'Only a reply can carry a photo.' }, { status: 400, headers });
  }
  const adminSupabase = (dependencies.createServiceClient ?? createServiceClient)();

  const refusal = (result: { error: string; code: Parameters<typeof supportRefusalStatus>[0] }) => NextResponse.json(
    { error: result.error, code: result.code },
    { status: supportRefusalStatus(result.code), headers },
  );

  try {
    if (action === 'reply') {
      const clientMessageId = isSupportClientMessageId(body.clientMessageId) ? body.clientMessageId : null;
      const replyToMessageId = body.replyToMessageId ?? null;
      if (replyToMessageId !== null && !isSupportMessageId(replyToMessageId)) {
        return NextResponse.json(
          { error: SUPPORT_REFUSAL_WORDS.REPLY_NOT_FOUND, code: 'REPLY_NOT_FOUND' },
          { status: 400, headers },
        );
      }
      const result = await (dependencies.replyToSupportConversation ?? replyToSupportConversation)({
        adminSupabase,
        conversationId,
        body: body.body,
        clientMessageId,
        replyToMessageId,
        photoBytes: photo,
      });

      if (!result.ok) return refusal(result);
      return NextResponse.json({ success: true, message: result.message, conversation: result.conversation }, { headers });
    }

    if (action === 'resolve' || action === 'reopen') {
      const result = await (dependencies.setSupportConversationStatus ?? setSupportConversationStatus)({
        adminSupabase,
        conversationId,
        status: action === 'resolve' ? 'resolved' : 'open',
      });

      if (!result.ok) return conversationNotFound(headers);
      return NextResponse.json({ success: true }, { headers });
    }

    // The rest act inside the conversation of the account it belongs to.
    const owner = await (dependencies.loadSupportConversationOwner ?? loadSupportConversationOwner)(adminSupabase, conversationId);
    if (!owner) return conversationNotFound(headers);

    if (action === 'read') {
      const result = await (dependencies.markSupportConversationRead ?? markSupportConversationRead)({
        adminSupabase,
        userId: owner.userId,
        reader: 'staff',
      });
      if (!result.ok) return conversationNotFound(headers);
      return NextResponse.json({
        success: true,
        userLastReadAt: result.userLastReadAt,
        staffLastReadAt: result.staffLastReadAt,
      }, { headers });
    }

    if (action === 'typing') {
      await (dependencies.setSupportConversationTyping ?? setSupportConversationTyping)({
        adminSupabase,
        userId: owner.userId,
        author: 'staff',
        typing: body.typing === true,
      });
      return NextResponse.json({ success: true }, { headers });
    }

    if (!isSupportMessageId(body.messageId)) {
      return NextResponse.json(
        { error: SUPPORT_REFUSAL_WORDS.MESSAGE_NOT_FOUND, code: 'MESSAGE_NOT_FOUND' },
        { status: 404, headers },
      );
    }

    const shared = { adminSupabase, userId: owner.userId, author: 'staff' as const, messageId: body.messageId };
    const result = action === 'edit'
      ? await (dependencies.editSupportMessage ?? editSupportMessage)({ ...shared, body: body.body })
      : action === 'delete'
        ? await (dependencies.deleteSupportMessage ?? deleteSupportMessage)(shared)
        : await (dependencies.setSupportMessageReaction ?? setSupportMessageReaction)({ ...shared, emoji: body.emoji ?? null });

    if (!result.ok) return refusal(result);
    return NextResponse.json({ success: true, message: result.message }, { headers });
  } catch (error) {
    logFailure(request, 'admin_support_action_failed', action, error);
    return NextResponse.json({ error: 'The support action failed. Try again.' }, { status: 500, headers });
  }
}

export function createAdminSupportRouteHandlers() {
  return {
    GET(request: Request) {
      return getAdminSupportThread(request);
    },
    POST(request: Request) {
      return postAdminSupportAction(request);
    },
  };
}
