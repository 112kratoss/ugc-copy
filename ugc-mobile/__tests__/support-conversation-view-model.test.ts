import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { ApiError } from '../lib/api-client';
import {
  SUPPORT_CLIENT_MESSAGE_ID_INVALID,
  SUPPORT_MESSAGE_EMPTY,
  SUPPORT_MESSAGE_TOO_LONG,
  SUPPORT_POLL_ACTIVE_MS,
  SUPPORT_POLL_WARM_AFTER_MS,
  SUPPORT_POLL_WARM_MS,
  SUPPORT_REFUSAL_WORDS,
  SUPPORT_WORDS,
  checkSupportMessage,
  isSupportClientMessageId,
  isSupportMessageId,
  isSupportReactionEmoji,
  readSupportConversationResponse,
  readSupportMessageResponse,
  readSupportMessageUpdateResponse,
  readSupportPhotoRequest,
  readSupportReadResponse,
  type SupportConversationResponse,
} from '../lib/support-conversation-policy/support-conversation-policy';
import {
  createSupportPollTracker,
  supportActionFailureWords,
  supportConversationAfterSend,
  supportConversationQueryKey,
  supportConversationWithMessage,
  supportConversationWithReadTimes,
  supportMessageSheetTitle,
  supportSendFailureWords,
} from '../lib/support-conversation-view-model';
import { SupportPhotoGoneError } from '../lib/support-photo-file';

const endpoints = mobileApiContract.endpoints;

describe('the support conversation as the contract pins it', () => {
  it('reads a conversation, every field the app draws, and none before the first message', () => {
    expect(readSupportConversationResponse(endpoints.getSupportConversation.response)).toEqual({
      conversation: endpoints.getSupportConversation.response.conversation,
      messages: endpoints.getSupportConversation.response.messages,
    });
    expect(readSupportConversationResponse(endpoints.getSupportConversation.responseVariants.noConversationYet))
      .toEqual({ conversation: null, messages: [] });
  });

  it('reads a sent message, and sends what the rule allows', () => {
    expect(readSupportMessageResponse(endpoints.sendSupportMessage.response)).toEqual({
      message: endpoints.sendSupportMessage.response.message,
      conversation: endpoints.sendSupportMessage.response.conversation,
    });
    expect(checkSupportMessage(endpoints.sendSupportMessage.request.body).ok).toBe(true);
    expect(isSupportClientMessageId(endpoints.sendSupportMessage.request.clientMessageId)).toBe(true);
    expect(isSupportMessageId(endpoints.sendSupportMessage.request.replyToMessageId)).toBe(true);
  });

  it('reads the answers to an edit, a delete, a reaction and a read', () => {
    expect(readSupportMessageUpdateResponse(endpoints.editSupportMessage.response)?.message.editedAt).toBe('2026-11-21T10:44:00.000Z');
    expect(readSupportMessageUpdateResponse(endpoints.deleteSupportMessage.response)?.message).toMatchObject({ body: null, deletedAt: '2026-11-21T10:45:00.000Z' });
    expect(readSupportMessageUpdateResponse(endpoints.reactToSupportMessage.response)?.message.reactions).toEqual([{ author: 'user', emoji: '🙏' }]);
    expect(isSupportReactionEmoji(endpoints.reactToSupportMessage.request.emoji)).toBe(true);
    expect(readSupportReadResponse(endpoints.markSupportConversationRead.response)).toEqual({
      userLastReadAt: endpoints.markSupportConversationRead.response.userLastReadAt,
      staffLastReadAt: endpoints.markSupportConversationRead.response.staffLastReadAt,
    });
  });

  it('reads photo messages whole, a quote of one, and a send that names a staged photo', () => {
    const withPhotos = endpoints.getSupportConversation.responseVariants.withPhotos;
    expect(readSupportConversationResponse(withPhotos)).toEqual({ conversation: withPhotos.conversation, messages: withPhotos.messages });
    expect(readSupportConversationResponse(withPhotos)?.messages[1].replyTo).toMatchObject({ hasPhoto: true, deleted: false, body: null });
    const sentPhoto = endpoints.sendSupportMessage.responseVariants.photo;
    expect(readSupportMessageResponse(sentPhoto)).toEqual({ message: sentPhoto.message, conversation: sentPhoto.conversation });
    const request = endpoints.sendSupportMessage.requestVariants.photo;
    expect(readSupportPhotoRequest(request.photo)).toEqual(request.photo);
    expect(checkSupportMessage(request.body, { hasPhoto: true })).toEqual({ ok: true, body: '' });
    expect(supportMessageSheetTitle(withPhotos.messages[0] as never)).toBe('📷 Photo');
  });

  it('refuses a photo with the words and statuses the server sends', () => {
    const errors = endpoints.sendSupportMessage.errors;
    expect(errors.photoNotFound).toEqual({ status: 409, response: { error: SUPPORT_REFUSAL_WORDS.PHOTO_NOT_FOUND, code: 'PHOTO_NOT_FOUND' } });
    expect(errors.photoUnreadable).toEqual({ status: 400, response: { error: SUPPORT_REFUSAL_WORDS.PHOTO_UNREADABLE, code: 'PHOTO_UNREADABLE' } });
    expect(errors.photoTooLarge).toEqual({ status: 413, response: { error: SUPPORT_REFUSAL_WORDS.PHOTO_TOO_LARGE, code: 'PHOTO_TOO_LARGE' } });
  });

  it('uses the refusal words the server sends', () => {
    expect(endpoints.sendSupportMessage.errors.emptyMessage.response.error).toBe(SUPPORT_MESSAGE_EMPTY);
    expect(endpoints.sendSupportMessage.errors.messageTooLong.response.error).toBe(SUPPORT_MESSAGE_TOO_LONG);
    expect(endpoints.sendSupportMessage.errors.invalidClientMessageId.response.error).toBe(SUPPORT_CLIENT_MESSAGE_ID_INVALID);
    expect(endpoints.sendSupportMessage.errors.replyNotFound.response.error).toBe(SUPPORT_REFUSAL_WORDS.REPLY_NOT_FOUND);
    expect(endpoints.editSupportMessage.errors.editTooLate.response.error).toBe(SUPPORT_REFUSAL_WORDS.EDIT_TOO_LATE);
    expect(endpoints.deleteSupportMessage.errors.deleteTooLate.response.error).toBe(SUPPORT_REFUSAL_WORDS.DELETE_TOO_LATE);
    expect(endpoints.reactToSupportMessage.errors.invalidReaction.response.error).toBe(SUPPORT_REFUSAL_WORDS.INVALID_REACTION);
  });
});

describe('the screen\'s query', () => {
  it('is keyed by the account, so a sign-out leaves nothing to another', () => {
    expect(supportConversationQueryKey('account-1')).toEqual(['support-conversation', 'account-1']);
    expect(supportConversationQueryKey(null)).toEqual(['support-conversation', null]);
  });

  it('adds a sent message and keeps the conversation\'s read times', () => {
    const current = endpoints.getSupportConversation.response as unknown as SupportConversationResponse;
    const next = supportConversationAfterSend(current, endpoints.sendSupportMessage.response as never);
    expect(next.messages.map((item) => item.id).at(-1)).toBe(endpoints.sendSupportMessage.response.message.id);
    expect(next.conversation).toMatchObject({ staffLastReadAt: '2026-11-21T10:29:00.000Z', status: 'open' });

    const first = supportConversationAfterSend(undefined, endpoints.sendSupportMessage.response as never);
    expect(first.conversation).toMatchObject({ id: endpoints.sendSupportMessage.response.conversation.id, staffTyping: false });
  });

  it('puts a changed message in its place, and moves read times on', () => {
    const current = endpoints.getSupportConversation.response as unknown as SupportConversationResponse;
    const edited = { ...current.messages[1], body: 'Edited', editedAt: '2026-11-21T10:50:00.000Z' };
    expect(supportConversationWithMessage(current, edited)?.messages[1]).toEqual(edited);
    expect(supportConversationWithMessage(undefined, edited)).toBeUndefined();
    expect(supportConversationWithReadTimes(current, { userLastReadAt: '2026-11-21T11:00:00.000Z', staffLastReadAt: null })?.conversation)
      .toMatchObject({ userLastReadAt: '2026-11-21T11:00:00.000Z', staffLastReadAt: '2026-11-21T10:29:00.000Z' });
  });

  it('reads again often while the thread moves, and less once it is quiet', () => {
    let clock = 0;
    const tracker = createSupportPollTracker(() => clock);
    const data = endpoints.getSupportConversation.response as unknown as SupportConversationResponse;
    expect(tracker.next(data)).toBe(SUPPORT_POLL_ACTIVE_MS);
    clock = SUPPORT_POLL_WARM_AFTER_MS;
    expect(tracker.next(data)).toBe(SUPPORT_POLL_WARM_MS);
    expect(tracker.next({ ...data, conversation: data.conversation ? { ...data.conversation, staffTyping: false } : null })).toBe(SUPPORT_POLL_ACTIVE_MS);
    clock += SUPPORT_POLL_WARM_AFTER_MS;
    tracker.touch();
    expect(tracker.next({ ...data, conversation: data.conversation ? { ...data.conversation, staffTyping: false } : null })).toBe(SUPPORT_POLL_ACTIVE_MS);
  });

  it('titles a message\'s long press with its text, cut short', () => {
    const current = endpoints.getSupportConversation.response as unknown as SupportConversationResponse;
    expect(supportMessageSheetTitle(current.messages[0])).toBe('My video failed but the credits did not come back.');
    expect(supportMessageSheetTitle({ ...current.messages[0], body: 'x'.repeat(80) })).toBe(`${'x'.repeat(59)}…`);
    expect(supportMessageSheetTitle(current.messages[2])).toBe(SUPPORT_WORDS.deleted);
  });
});

describe('what the screen says when something did not go through', () => {
  it('passes the server\'s words for a refusal the person can act on', () => {
    expect(supportSendFailureWords(new ApiError('That message is over 2,000 characters.', 400))).toBe('That message is over 2,000 characters.');
    expect(supportActionFailureWords(new ApiError(SUPPORT_REFUSAL_WORDS.EDIT_TOO_LATE, 409))).toBe(SUPPORT_REFUSAL_WORDS.EDIT_TOO_LATE);
  });

  it('says the general line for a fault of ours, a lost connection or an ended session', () => {
    expect(supportSendFailureWords(new ApiError('Failed to send your message.', 500))).toBe(SUPPORT_WORDS.sendFailed);
    expect(supportSendFailureWords(new ApiError('Unauthorized', 401))).toBe(SUPPORT_WORDS.sendFailed);
    expect(supportSendFailureWords(new TypeError('Network request failed'))).toBe(SUPPORT_WORDS.sendFailed);
    expect(supportActionFailureWords(new TypeError('Network request failed'))).toBe(SUPPORT_WORDS.actionFailed);
  });

  it('says a photo the phone no longer has is gone, since no try can send it', () => {
    expect(supportSendFailureWords(new SupportPhotoGoneError())).toBe(SUPPORT_WORDS.photoGone);
    expect(SUPPORT_WORDS.photoGone).not.toBe(SUPPORT_WORDS.sendFailed);
  });
});
