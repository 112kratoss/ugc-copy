'use client';

import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';

import {
  isSupportPhotoRefusal,
  readSupportConversationResponse,
  readSupportMessageResponse,
  readSupportMessageUpdateResponse,
  readSupportReadResponse,
} from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

import { shrinkConsolePhoto } from './shrink-console-photo';
import type { SupportChatActionResult, SupportChatLoadResult, SupportChatTransport } from './use-support-chat';

/**
 * How each side of a support thread talks to the server: the account through
 * `/api/support/*` with its session's bearer token, the operator through
 * `/api/admin/support` with the console's cookie. The account's photo is
 * staged like any upload and named in the send; the console's goes with its
 * send, shrunk under the host's request cap.
 */

/**
 * How long a request may take before it is given up as failed: a read or an
 * action, and a send that carries a photo. Sends go one at a time, so a
 * request that never answered would hold every later message as "sending";
 * given up, it is "not sent" (or settled by the next read if it was kept).
 */
export const SUPPORT_REQUEST_TIMEOUT_MS = 30_000;
export const SUPPORT_PHOTO_REQUEST_TIMEOUT_MS = 120_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A refusal the person should read (the server's words), or null for a fault of ours. */
function refusalWords(response: Response, json: Record<string, unknown> | null): string | null {
  if (response.status >= 500) return null;
  return typeof json?.error === 'string' ? json.error : null;
}

async function action<T>(
  request: () => Promise<Response>,
  read: (json: Record<string, unknown> | null) => T | null,
): Promise<SupportChatActionResult<T>> {
  try {
    const response = await request();
    const json = await readJson(response);
    if (response.status === 401) return { ok: false, error: null, signedOut: true };
    const value = response.ok ? read(json) : null;
    if (value) return { ok: true, value };
    return {
      ok: false,
      error: refusalWords(response, json),
      code: response.status < 500 && typeof json?.code === 'string' ? json.code : null,
    };
  } catch {
    return { ok: false, error: null };
  }
}

function readLoad(response: Response, json: Record<string, unknown> | null): SupportChatLoadResult {
  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 403 && json?.code === 'REGISTRATION_REQUIRED') return { kind: 'registration-required' };
  if (response.status === 404) return { kind: 'not-found' };
  const parsed = response.ok ? readSupportConversationResponse(json) : null;
  return parsed ? { kind: 'ok', ...parsed } : { kind: 'failed' };
}

/** The account's own thread, with the session's token read fresh for every request. */
export function createAccountSupportTransport(
  authHeaders: () => Promise<Record<string, string>>,
): SupportChatTransport {
  const jsonRequest = async (path: string, method: string, body?: unknown) => fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(await authHeaders()) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: timeoutSignal(SUPPORT_REQUEST_TIMEOUT_MS),
  });
  // Photos staged for a send that did not go through, by the send's client id.
  const stagedPhotos = new Map<string, string>();

  return {
    async load() {
      try {
        const response = await jsonRequest('/api/support/conversation', 'GET');
        return readLoad(response, await readJson(response));
      } catch {
        return { kind: 'failed' };
      }
    },
    async send({ body, clientMessageId, replyToMessageId, photo }) {
      let storagePath: string | null = null;
      if (photo) {
        // A retry names the photo already staged rather than sending it again.
        storagePath = stagedPhotos.get(clientMessageId) ?? null;
        if (!storagePath) {
          try {
            const signal = timeoutSignal(SUPPORT_PHOTO_REQUEST_TIMEOUT_MS);
            storagePath = (await uploadMediaToTemporaryStorage(photo, signal ? { signal } : {})).storagePath;
          } catch {
            // The picker already held the type and size to the rule: what is
            // left is a lost connection or a fault, the general line's case.
            return { ok: false, error: null };
          }
          stagedPhotos.set(clientMessageId, storagePath);
        }
      }
      const result = await action(
        () => jsonRequest('/api/support/conversation', 'POST', {
          body,
          clientMessageId,
          replyToMessageId,
          ...(storagePath ? { photo: { storagePath } } : {}),
        }),
        readSupportMessageResponse,
      );
      // Kept, or refused for the photo itself: the next try, if any, stages it
      // anew. Any other refusal (a quote gone, too many at once) keeps it staged.
      if (result.ok || isSupportPhotoRefusal(result.code)) stagedPhotos.delete(clientMessageId);
      return result;
    },
    forget(clientMessageId) {
      stagedPhotos.delete(clientMessageId);
    },
    edit: (messageId, body) => action(
      () => jsonRequest(`/api/support/messages/${encodeURIComponent(messageId)}`, 'PATCH', { body }),
      readSupportMessageUpdateResponse,
    ),
    remove: (messageId) => action(
      () => jsonRequest(`/api/support/messages/${encodeURIComponent(messageId)}`, 'DELETE'),
      readSupportMessageUpdateResponse,
    ),
    react: (messageId, emoji) => action(
      () => jsonRequest(`/api/support/messages/${encodeURIComponent(messageId)}/reaction`, 'POST', { emoji }),
      readSupportMessageUpdateResponse,
    ),
    markRead: (upToMessageId) => action(
      () => jsonRequest('/api/support/conversation/read', 'POST', { upToMessageId }),
      readSupportReadResponse,
    ),
    async typing(typing) {
      await jsonRequest('/api/support/conversation/typing', 'POST', { typing }).catch(() => undefined);
    },
  };
}

/** The console's view of one account's thread. */
export function createAdminSupportTransport(conversationId: string): SupportChatTransport {
  const post = (body: Record<string, unknown>) => fetch('/api/admin/support', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, ...body }),
    cache: 'no-store',
    signal: timeoutSignal(SUPPORT_REQUEST_TIMEOUT_MS),
  });

  return {
    async load() {
      try {
        const response = await fetch(`/api/admin/support?conversationId=${encodeURIComponent(conversationId)}`, {
          cache: 'no-store',
          signal: timeoutSignal(SUPPORT_REQUEST_TIMEOUT_MS),
        });
        return readLoad(response, await readJson(response));
      } catch {
        return { kind: 'failed' };
      }
    },
    async send({ body, clientMessageId, replyToMessageId, photo }) {
      if (!photo) {
        return action(
          () => post({ action: 'reply', body, clientMessageId, replyToMessageId }),
          readSupportMessageResponse,
        );
      }
      let shrunk: Blob;
      try {
        shrunk = await shrinkConsolePhoto(photo);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : null };
      }
      const form = new FormData();
      form.set('action', 'reply');
      form.set('conversationId', conversationId);
      form.set('body', body);
      form.set('clientMessageId', clientMessageId);
      if (replyToMessageId) form.set('replyToMessageId', replyToMessageId);
      form.set('photo', shrunk, photo.name || 'photo');
      return action(
        () => fetch('/api/admin/support', {
          method: 'POST',
          body: form,
          cache: 'no-store',
          signal: timeoutSignal(SUPPORT_PHOTO_REQUEST_TIMEOUT_MS),
        }),
        readSupportMessageResponse,
      );
    },
    edit: (messageId, body) => action(() => post({ action: 'edit', messageId, body }), readSupportMessageUpdateResponse),
    remove: (messageId) => action(() => post({ action: 'delete', messageId }), readSupportMessageUpdateResponse),
    react: (messageId, emoji) => action(() => post({ action: 'react', messageId, emoji }), readSupportMessageUpdateResponse),
    markRead: (upToMessageId) => action(() => post({ action: 'read', upToMessageId }), readSupportReadResponse),
    async typing(typing) {
      await post({ action: 'typing', typing }).catch(() => undefined);
    },
  };
}
