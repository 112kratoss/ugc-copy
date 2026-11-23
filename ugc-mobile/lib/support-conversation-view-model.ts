import { ApiError } from './api-client';
import {
  SUPPORT_WORDS,
  supportPollDelay,
  supportQuoteText,
  supportThreadSignature,
  withSupportConversationRef,
  withSupportMessage,
  withSupportReadTimes,
  type SupportConversationResponse,
  type SupportMessage,
  type SupportMessageResponse,
  type SupportReadResponse,
} from './support-conversation-policy/support-conversation-policy';
import { SupportPhotoGoneError } from './support-photo-file';

/**
 * The app's Message support screen (`app/support.tsx`), apart from React: the
 * query it reads, how often it reads it again, the words for a send or a
 * change that did not go through, and the conversation once the server
 * answered. The rules shared with the web and the server are in
 * `support-conversation-policy/`.
 */

export const SUPPORT_CONVERSATION_QUERY_KEY = 'support-conversation';

export function supportConversationQueryKey(userId: string | null) {
  return [SUPPORT_CONVERSATION_QUERY_KEY, userId] as const;
}

function refusalWords(error: unknown): string | null {
  if (
    error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && error.status !== 401
    && error.message
  ) {
    return error.message;
  }
  return null;
}

/**
 * What the screen says under a message that was not sent. A refusal the
 * person can act on (too long, too many at once) is the server's own words; a
 * photo no longer on the phone says so, since no try can send it; anything
 * else, a lost connection or a fault of ours, is the general line.
 */
export function supportSendFailureWords(error: unknown): string {
  if (error instanceof SupportPhotoGoneError) return SUPPORT_WORDS.photoGone;
  return refusalWords(error) ?? SUPPORT_WORDS.sendFailed;
}

/** The same for an edit, a delete or a reaction. */
export function supportActionFailureWords(error: unknown): string {
  return refusalWords(error) ?? SUPPORT_WORDS.actionFailed;
}

/** The conversation as the query holds it once the server kept a message. */
export function supportConversationAfterSend(
  current: SupportConversationResponse | undefined,
  sent: Pick<SupportMessageResponse, 'message' | 'conversation'>,
): SupportConversationResponse {
  return {
    success: true,
    conversation: withSupportConversationRef(current?.conversation ?? null, sent.conversation),
    messages: withSupportMessage(current?.messages ?? [], sent.message),
  };
}

/** The conversation with one message as the server (or the screen, ahead of it) now has it. */
export function supportConversationWithMessage(
  current: SupportConversationResponse | undefined,
  message: SupportMessage,
): SupportConversationResponse | undefined {
  if (!current) return current;
  return { ...current, messages: withSupportMessage(current.messages, message) };
}

/** The conversation with both sides' read times after a read. */
export function supportConversationWithReadTimes(
  current: SupportConversationResponse | undefined,
  read: Pick<SupportReadResponse, 'userLastReadAt' | 'staffLastReadAt'>,
): SupportConversationResponse | undefined {
  if (!current) return current;
  return { ...current, conversation: withSupportReadTimes(current.conversation, read) };
}

/**
 * How long the open screen waits before reading the thread again: often
 * while things move, less once nothing has changed for a minute. The tracker
 * remembers the last thread it saw and when it last changed.
 */
export function createSupportPollTracker(now: () => number = Date.now) {
  let signature = '';
  let changedAt = now();
  return {
    /** Called with each answer; answers the wait before the next read. */
    next(data: SupportConversationResponse | undefined): number {
      const current = data ? supportThreadSignature(data.conversation, data.messages) : '';
      const time = now();
      if (current !== signature) {
        signature = current;
        changedAt = time;
      }
      return supportPollDelay(changedAt, time);
    },
    /** Something happened on this side (a send, a reaction, typing): read often again. */
    touch() {
      changedAt = now();
    },
  };
}

/** The title of a message's long-press sheet: its text on one line ("📷 Photo" for a photo), cut short. */
export function supportMessageSheetTitle(message: SupportMessage): string {
  const text = supportQuoteText({
    body: message.body,
    deleted: Boolean(message.deletedAt),
    hasPhoto: Boolean(message.attachment),
  });
  const characters = Array.from(text);
  return characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : text;
}
