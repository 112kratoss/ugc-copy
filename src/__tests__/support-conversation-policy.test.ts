import { describe, expect, it, vi } from 'vitest';

import { siteConfig } from '@/lib/seo';
import { TEMPORARY_MEDIA_UPLOAD_LIMITS } from '@/lib/temporary-media-upload';

// The upload client builds the browser's Supabase client when it loads; only its limits are read here.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  SUPPORT_DELETE_WINDOW_HOURS,
  SUPPORT_EDIT_WINDOW_MINUTES,
  SUPPORT_EMAIL,
  SUPPORT_MESSAGE_EMPTY,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_MESSAGE_TOO_LONG,
  SUPPORT_PHOTO_LINK_RENEW_BEFORE_MS,
  SUPPORT_PHOTO_MAX_BYTES,
  SUPPORT_PHOTO_TYPES,
  SUPPORT_POLL_ACTIVE_MS,
  SUPPORT_POLL_COLD_AFTER_MS,
  SUPPORT_POLL_COLD_MS,
  SUPPORT_POLL_WARM_AFTER_MS,
  SUPPORT_POLL_WARM_MS,
  SUPPORT_REACTION_EMOJIS,
  SUPPORT_REFUSAL_WORDS,
  SUPPORT_TYPING_PING_MS,
  SUPPORT_TYPING_SECONDS,
  SUPPORT_WORDS,
  canDeleteSupportMessage,
  canEditSupportMessage,
  checkSupportMessage,
  createSupportClientMessageId,
  failPendingSupportMessage,
  isSupportPhotoRefusal,
  supportInitials,
  withoutKeptPendingMessages,
  isSupportClientMessageId,
  isSupportMessageId,
  isSupportPhotoType,
  isSupportReactionEmoji,
  readSupportConversationResponse,
  readSupportMessage,
  readSupportMessageResponse,
  readSupportMessageUpdateResponse,
  readSupportPhoto,
  readSupportPhotoRequest,
  readSupportReadResponse,
  settlePendingSupportMessage,
  startPendingSupportMessage,
  supportDayLabel,
  supportDeletedMessage,
  supportDeletedWords,
  supportEditedMessage,
  supportMessageLength,
  supportMessageReceipt,
  supportOtherSideTyping,
  supportPhotoFrame,
  supportPhotoPickRefusal,
  supportPollDelay,
  supportPreviewText,
  supportQuoteAuthorName,
  supportQuoteOf,
  supportQuoteText,
  supportReactionToggle,
  supportReplyAlertWords,
  supportShouldPingTyping,
  supportTextSegments,
  supportThreadRows,
  supportThreadSignature,
  supportUnreadMessages,
  supportUnreadWords,
  withStableSupportPhotoLinks,
  withSupportConversationRef,
  withSupportMessage,
  withSupportReadTimes,
  type SupportConversationSummary,
  type SupportMessage,
  type SupportPendingMessage,
  type SupportPhoto,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

function message(overrides: Partial<SupportMessage> & Pick<SupportMessage, 'id'>): SupportMessage {
  return {
    author: 'user',
    clientMessageId: null,
    body: 'Hello',
    createdAt: '2026-11-21T09:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    replyTo: null,
    reactions: [],
    attachment: null,
    ...overrides,
  };
}

const userMessage = message({ id: 'm1' });
const staffMessage = message({ id: 'm2', author: 'staff', body: 'Hi', createdAt: '2026-11-21T10:00:00+00:00' });

const summary: SupportConversationSummary = {
  id: 'c1',
  status: 'open',
  userLastReadAt: null,
  staffLastReadAt: null,
  userTyping: false,
  staffTyping: false,
};

describe('the rule a support message is sent by', () => {
  it('sends the text trimmed', () => {
    expect(checkSupportMessage('  My credits did not come back.\n')).toEqual({ ok: true, body: 'My credits did not come back.' });
  });

  it.each([[''], ['   \n\t '], [null], [42], [undefined]])('refuses %j as empty', (text) => {
    expect(checkSupportMessage(text)).toEqual({ ok: false, code: 'EMPTY_MESSAGE', error: SUPPORT_MESSAGE_EMPTY });
  });

  it('takes 2,000 characters and refuses one more', () => {
    expect(checkSupportMessage('a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH)).ok).toBe(true);
    expect(checkSupportMessage('a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1)))
      .toEqual({ ok: false, code: 'MESSAGE_TOO_LONG', error: SUPPORT_MESSAGE_TOO_LONG });
  });

  // The database counts code points (char_length): an emoji is one, as a person counts it.
  it('counts characters as people do, not UTF-16 units', () => {
    const emoji = '😀'.repeat(SUPPORT_MESSAGE_MAX_LENGTH);
    expect(emoji.length).toBe(SUPPORT_MESSAGE_MAX_LENGTH * 2);
    expect(checkSupportMessage(emoji).ok).toBe(true);
    expect(supportMessageLength('  😀😀 ')).toBe(2);
  });
});

describe('ids', () => {
  it('makes a client id from the runtime\'s UUID where it has one', () => {
    const id = createSupportClientMessageId(() => '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
    expect(id).toBe('msg:0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f');
    expect(isSupportClientMessageId(id)).toBe(true);
  });

  // Hermes may have no crypto.randomUUID.
  it('makes one from the time and a random tail without one, still a valid id', () => {
    const id = createSupportClientMessageId(null, () => 1_763_700_000_000, () => 0.5);
    expect(id).toMatch(/^msg:[0-9a-z]+:[0-9a-z]{10}$/);
    expect(isSupportClientMessageId(id)).toBe(true);
    expect(createSupportClientMessageId(null, () => 1_763_700_000_000, () => 0.25)).not.toBe(id);
  });

  it.each([['short'], ['has spaces in it'], ['x'.repeat(101)], [42], [null]])('refuses %j as a client id', (value) => {
    expect(isSupportClientMessageId(value)).toBe(false);
  });

  it('takes a message id only as a UUID', () => {
    expect(isSupportMessageId('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')).toBe(true);
    expect(isSupportMessageId('../conversation')).toBe(false);
    expect(isSupportMessageId(undefined)).toBe(false);
  });
});

describe('edits and deletes', () => {
  const sent = Date.parse('2026-11-21T09:00:00.000Z');

  it('lets the author edit for 15 minutes and no longer', () => {
    expect(SUPPORT_EDIT_WINDOW_MINUTES).toBe(15);
    expect(canEditSupportMessage(userMessage, 'user', sent + 14 * 60_000)).toBe(true);
    expect(canEditSupportMessage(userMessage, 'user', sent + 15 * 60_000)).toBe(false);
    expect(canEditSupportMessage(userMessage, 'staff', sent)).toBe(false);
    expect(canEditSupportMessage({ ...userMessage, deletedAt: '2026-11-21T09:01:00.000Z', body: null }, 'user', sent)).toBe(false);
  });

  it('lets the author delete for everyone for 48 hours and no longer', () => {
    expect(SUPPORT_DELETE_WINDOW_HOURS).toBe(48);
    expect(canDeleteSupportMessage(userMessage, 'user', sent + 47 * 3_600_000)).toBe(true);
    expect(canDeleteSupportMessage(userMessage, 'user', sent + 48 * 3_600_000)).toBe(false);
    expect(canDeleteSupportMessage(staffMessage, 'user', Date.parse(staffMessage.createdAt))).toBe(false);
  });

  it('draws an edit and a delete ahead of the server', () => {
    expect(supportEditedMessage(userMessage, 'Hello again', '2026-11-21T09:05:00.000Z'))
      .toMatchObject({ body: 'Hello again', editedAt: '2026-11-21T09:05:00.000Z' });
    const reacted = { ...userMessage, reactions: [{ author: 'staff' as const, emoji: '👍' as const }] };
    expect(supportDeletedMessage(reacted, '2026-11-21T09:06:00.000Z'))
      .toMatchObject({ body: null, deletedAt: '2026-11-21T09:06:00.000Z', reactions: [] });
  });

  it('says who deleted a message', () => {
    expect(supportDeletedWords(userMessage, 'user')).toBe(SUPPORT_WORDS.youDeleted);
    expect(supportDeletedWords(userMessage, 'staff')).toBe(SUPPORT_WORDS.deleted);
  });
});

describe('reactions', () => {
  it('offers the six quick reactions and takes only those', () => {
    expect(SUPPORT_REACTION_EMOJIS).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
    expect(isSupportReactionEmoji('❤️')).toBe(true);
    expect(isSupportReactionEmoji('🤡')).toBe(false);
  });

  it('sets the viewer\'s reaction, replaces it, and takes it away when chosen again', () => {
    const first = supportReactionToggle(staffMessage, 'user', '👍');
    expect(first.emoji).toBe('👍');
    expect(first.message.reactions).toEqual([{ author: 'user', emoji: '👍' }]);

    const withStaff = { ...first.message, reactions: [{ author: 'staff' as const, emoji: '❤️' as const }, ...first.message.reactions] };
    const replaced = supportReactionToggle(withStaff, 'user', '😂');
    expect(replaced.message.reactions).toEqual([{ author: 'staff', emoji: '❤️' }, { author: 'user', emoji: '😂' }]);

    const removed = supportReactionToggle(replaced.message, 'user', '😂');
    expect(removed.emoji).toBeNull();
    expect(removed.message.reactions).toEqual([{ author: 'staff', emoji: '❤️' }]);
  });
});

describe('ticks, unread and typing', () => {
  it('shows one tick until the other side has read past a message, then two', () => {
    expect(supportMessageReceipt(userMessage, summary, 'user')).toBe('sent');
    expect(supportMessageReceipt(userMessage, { ...summary, staffLastReadAt: '2026-11-21T08:59:59.000Z' }, 'user')).toBe('sent');
    expect(supportMessageReceipt(userMessage, { ...summary, staffLastReadAt: '2026-11-21T09:00:00+00:00' }, 'user')).toBe('read');
    expect(supportMessageReceipt(staffMessage, { ...summary, userLastReadAt: '2026-11-21T11:00:00Z' }, 'staff')).toBe('read');
  });

  it('shows no ticks on the other side\'s messages or a deleted one', () => {
    expect(supportMessageReceipt(staffMessage, summary, 'user')).toBeNull();
    expect(supportMessageReceipt({ ...userMessage, deletedAt: '2026-11-21T09:01:00Z', body: null }, summary, 'user')).toBeNull();
  });

  it('counts the other side\'s messages after the read time as unread, deleted ones aside', () => {
    const later = message({ id: 'm3', author: 'staff', body: 'Any news?', createdAt: '2026-11-21T12:00:00Z' });
    const gone = message({ id: 'm4', author: 'staff', body: null, deletedAt: '2026-11-21T12:30:00Z', createdAt: '2026-11-21T12:10:00Z' });
    const thread = [userMessage, staffMessage, later, gone];
    expect(supportUnreadMessages(thread, 'user', null).map((item) => item.id)).toEqual(['m2', 'm3']);
    expect(supportUnreadMessages(thread, 'user', '2026-11-21T10:00:00Z').map((item) => item.id)).toEqual(['m3']);
    expect(supportUnreadMessages(thread, 'staff', null).map((item) => item.id)).toEqual(['m1']);
    expect(supportUnreadWords(1)).toBe('1 unread message');
    expect(supportUnreadWords(3)).toBe('3 unread messages');
  });

  it('reads the other side\'s typing', () => {
    expect(supportOtherSideTyping({ userTyping: true, staffTyping: false }, 'user')).toBe(false);
    expect(supportOtherSideTyping({ userTyping: false, staffTyping: true }, 'user')).toBe(true);
    expect(supportOtherSideTyping({ userTyping: true, staffTyping: false }, 'staff')).toBe(true);
    expect(supportOtherSideTyping(null, 'staff')).toBe(false);
  });

  it('pings typing inside the server\'s window, and asks often only while things move', () => {
    expect(SUPPORT_TYPING_PING_MS).toBeLessThan(SUPPORT_TYPING_SECONDS * 1000);
    expect(supportShouldPingTyping(null, 1000)).toBe(true);
    expect(supportShouldPingTyping(1000, 1000 + SUPPORT_TYPING_PING_MS - 1)).toBe(false);
    expect(supportShouldPingTyping(1000, 1000 + SUPPORT_TYPING_PING_MS)).toBe(true);
    expect(supportPollDelay(0, SUPPORT_POLL_WARM_AFTER_MS - 1)).toBe(SUPPORT_POLL_ACTIVE_MS);
    expect(supportPollDelay(0, SUPPORT_POLL_WARM_AFTER_MS)).toBe(SUPPORT_POLL_WARM_MS);
    expect(supportPollDelay(0, SUPPORT_POLL_COLD_AFTER_MS)).toBe(SUPPORT_POLL_COLD_MS);
    // A conversation going on is read again inside the time a "typing…" lasts,
    // so the other side's typing is never missed between two reads.
    expect(SUPPORT_POLL_ACTIVE_MS).toBeLessThan(SUPPORT_TYPING_SECONDS * 1000);
    expect(SUPPORT_POLL_WARM_MS).toBeLessThan(SUPPORT_TYPING_SECONDS * 1000);
  });

  it('fingerprints what a thread shows, so a quiet read changes nothing', () => {
    const before = supportThreadSignature(summary, [userMessage]);
    expect(supportThreadSignature({ ...summary }, [{ ...userMessage }])).toBe(before);
    expect(supportThreadSignature({ ...summary, staffTyping: true }, [userMessage])).not.toBe(before);
    expect(supportThreadSignature(summary, [{ ...userMessage, reactions: [{ author: 'staff', emoji: '👍' }] }])).not.toBe(before);
  });
});

describe('days, groups and the unread divider', () => {
  const now = new Date(2026, 10, 21, 18, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).toISOString();

  it('labels a day Today, Yesterday, its weekday within the week, else its date', () => {
    expect(supportDayLabel(at(21, 9), now, 'en-US')).toBe('Today');
    expect(supportDayLabel(at(20, 23), now, 'en-US')).toBe('Yesterday');
    expect(supportDayLabel(at(17, 9), now, 'en-US')).toBe('Tuesday');
    expect(supportDayLabel(at(10, 9), now, 'en-US')).toBe('November 10');
    expect(supportDayLabel(new Date(2025, 11, 31, 9).toISOString(), now, 'en-US')).toBe('December 31, 2025');
  });

  it('draws a label at each day, groups one side\'s run, and puts the divider above the first unread', () => {
    const thread = [
      message({ id: 'a', createdAt: at(20, 9) }),
      message({ id: 'b', createdAt: at(20, 10) }),
      message({ id: 'c', author: 'staff', createdAt: at(21, 9) }),
      message({ id: 'd', author: 'staff', createdAt: at(21, 10) }),
      message({ id: 'e', author: 'staff', createdAt: at(21, 11) }),
    ];
    const pending = startPendingSupportMessage([], { clientMessageId: 'msg:p-0000001', body: 'Thanks', now: at(21, 12) });
    const rows = supportThreadRows({
      messages: thread,
      pending,
      conversation: summary,
      viewer: 'user',
      unreadFromId: 'd',
      unreadCount: 2,
      now,
      locale: 'en-US',
    });

    expect(rows.map((row) => (row.kind === 'message'
      ? `${row.message.id}${row.startsGroup ? '^' : ''}${row.endsGroup ? '$' : ''}`
      : row.kind === 'pending' ? `p${row.startsGroup ? '^' : ''}${row.endsGroup ? '$' : ''}` : row.label)))
      .toEqual(['Yesterday', 'a^', 'b$', 'Today', 'c^$', '2 unread messages', 'd^', 'e$', 'p^$']);
  });

  it('adds a kept message once, in time order whatever its time was written with, and replaces a changed one', () => {
    const later = { ...staffMessage, id: 'm3', createdAt: '2026-11-21T09:30:00Z' };
    expect(withSupportMessage([userMessage, staffMessage], later).map((item) => item.id)).toEqual(['m1', 'm3', 'm2']);
    const edited = { ...staffMessage, body: 'Hi there', editedAt: '2026-11-21T10:01:00Z' };
    expect(withSupportMessage([userMessage, staffMessage], edited)).toEqual([userMessage, edited]);
  });

  // A runtime that cannot read the server's microseconds still keeps the server's order.
  it('falls back to the text of the time where a time does not read', () => {
    const early = { ...userMessage, id: 'e', createdAt: 'not-a-time-1' };
    const late = { ...staffMessage, id: 'l', createdAt: 'not-a-time-2' };
    expect(withSupportMessage([late], early).map((item) => item.id)).toEqual(['e', 'l']);
  });
});

describe('the waiting list', () => {
  it('keeps a failed send in place for a retry, with its quote, and settles it once kept', () => {
    const quote = supportQuoteOf(staffMessage);
    let pending = startPendingSupportMessage([], { clientMessageId: 'msg:a-0000001', body: 'One', now: '2026-11-21T11:00:00.000Z', replyTo: quote });
    pending = startPendingSupportMessage(pending, { clientMessageId: 'msg:b-0000002', body: 'Two', now: '2026-11-21T11:01:00.000Z' });
    pending = failPendingSupportMessage(pending, 'msg:a-0000001');
    expect(pending.map((item) => [item.body, item.state, item.replyTo?.id ?? null])).toEqual([
      ['One', 'failed', 'm2'],
      ['Two', 'sending', null],
    ]);

    const retried = startPendingSupportMessage(pending, { clientMessageId: 'msg:a-0000001', body: 'One', now: '2026-11-21T12:00:00.000Z' });
    expect(retried[0]).toMatchObject({ state: 'sending', createdAt: '2026-11-21T11:00:00.000Z' });
    expect(settlePendingSupportMessage(retried, 'msg:a-0000001').map((item) => item.body)).toEqual(['Two']);
  });
});

describe('quotes and links', () => {
  it('quotes a message, says who wrote it, and says when it was deleted', () => {
    expect(supportQuoteOf(staffMessage)).toEqual({ id: 'm2', author: 'staff', body: 'Hi', deleted: false, hasPhoto: false });
    expect(supportQuoteText({ body: 'One\n\ntwo  three', deleted: false })).toBe('One two three');
    expect(supportQuoteText({ body: null, deleted: true })).toBe(SUPPORT_WORDS.deleted);
    expect(supportQuoteAuthorName('user', 'user')).toBe('You');
    expect(supportQuoteAuthorName('staff', 'user')).toBe(SUPPORT_WORDS.supportName);
    expect(supportQuoteAuthorName('user', 'staff', 'Asha')).toBe('Asha');
  });

  it('marks web addresses as links, keeping the punctuation after them as text', () => {
    expect(supportTextSegments('See https://magicbooklet.com/help, or www.example.com.')).toEqual([
      { kind: 'text', text: 'See ', start: 0 },
      { kind: 'link', text: 'https://magicbooklet.com/help', href: 'https://magicbooklet.com/help', start: 4 },
      { kind: 'text', text: ', or ', start: 33 },
      { kind: 'link', text: 'www.example.com', href: 'https://www.example.com', start: 38 },
      { kind: 'text', text: '.', start: 53 },
    ]);
    expect(supportTextSegments('No links here')).toEqual([{ kind: 'text', text: 'No links here', start: 0 }]);
  });
});

describe('the answers both clients read', () => {
  it('reads a conversation, leaving out a message it cannot read', () => {
    expect(readSupportConversationResponse({
      success: true,
      conversation: { id: 'c1', status: 'resolved', staffLastReadAt: '2026-11-21T10:00:00Z', staffTyping: true },
      messages: [userMessage, { id: 'm9', author: 'robot', body: 'x', createdAt: '2026-11-21T09:00:00.000Z' }, staffMessage],
    })).toEqual({
      conversation: { ...summary, status: 'resolved', staffLastReadAt: '2026-11-21T10:00:00Z', staffTyping: true },
      messages: [userMessage, staffMessage],
    });
  });

  it('reads a deleted message without its text, and a reply\'s quote', () => {
    expect(readSupportMessage({ id: 'm5', author: 'user', body: 'gone?', createdAt: '2026-11-21T09:00:00Z', deletedAt: '2026-11-21T09:02:00Z', reactions: [{ author: 'staff', emoji: '👍' }] }))
      .toMatchObject({ body: null, deletedAt: '2026-11-21T09:02:00Z', reactions: [] });
    expect(readSupportMessage({ id: 'm6', author: 'user', createdAt: '2026-11-21T09:00:00Z' })).toBeNull();
    expect(readSupportMessage({
      id: 'm7',
      author: 'staff',
      body: 'Yes',
      createdAt: '2026-11-21T09:00:00Z',
      replyTo: { id: 'm1', author: 'user', body: null, deleted: true },
      reactions: [{ author: 'user', emoji: '🙏' }, { author: 'user', emoji: '👍' }, { author: 'staff', emoji: '🤡' }],
    })).toMatchObject({
      replyTo: { id: 'm1', author: 'user', body: null, deleted: true },
      reactions: [{ author: 'user', emoji: '🙏' }],
    });
  });

  it('reads no conversation yet, and refuses what is not an answer', () => {
    expect(readSupportConversationResponse({ success: true, conversation: null, messages: [] }))
      .toEqual({ conversation: null, messages: [] });
    expect(readSupportConversationResponse({ success: true })).toBeNull();
    expect(readSupportConversationResponse(null)).toBeNull();
    expect(readSupportMessageResponse({ success: true, message: userMessage })).toBeNull();
    expect(readSupportMessageResponse({ success: true, message: userMessage, conversation: { id: 'c1', status: 'open' } }))
      .toEqual({ message: userMessage, conversation: { id: 'c1', status: 'open' } });
    expect(readSupportMessageUpdateResponse({ success: true, message: staffMessage })).toEqual({ message: staffMessage });
    expect(readSupportReadResponse({ success: true, userLastReadAt: '2026-11-21T10:00:00Z', staffLastReadAt: null }))
      .toEqual({ userLastReadAt: '2026-11-21T10:00:00Z', staffLastReadAt: null });
    expect(readSupportReadResponse({ userLastReadAt: 'x' })).toBeNull();
  });

  it('moves read times on, never back, and keeps the rest when a send answers', () => {
    const read = withSupportReadTimes({ ...summary, staffLastReadAt: '2026-11-21T10:00:00Z' }, {
      userLastReadAt: '2026-11-21T11:00:00Z',
      staffLastReadAt: '2026-11-21T09:00:00Z',
    });
    expect(read).toMatchObject({ userLastReadAt: '2026-11-21T11:00:00Z', staffLastReadAt: '2026-11-21T10:00:00Z' });
    expect(withSupportConversationRef(read, { id: 'c1', status: 'open' })).toEqual(read);
    expect(withSupportConversationRef(null, { id: 'c2', status: 'open' })).toEqual({ ...summary, id: 'c2' });
  });
});

describe('the alert about a reply', () => {
  it('says support replied, with the start of the reply on one line', () => {
    expect(supportReplyAlertWords('  Sorry.\n\nThe credits are back.  ')).toEqual({
      title: 'Support replied',
      body: 'Sorry. The credits are back.',
    });
    expect(supportReplyAlertWords('é'.repeat(141)).body).toBe(`${'é'.repeat(139)}…`);
    expect(supportReplyAlertWords('é'.repeat(140)).body).toBe('é'.repeat(140));
  });
});

describe('photos', () => {
  const photo: SupportPhoto = {
    kind: 'image',
    previewUrl: 'https://storage.example/preview.webp?token=a',
    url: 'https://storage.example/full.webp?token=a',
    width: 1080,
    height: 1920,
    thumbhash: 'abc=',
    expiresAt: '2026-11-21T12:00:00.000Z',
  };
  const photoMessage = message({ id: 'p1', body: null, attachment: photo });

  it('sends a photo with an empty caption, and still holds a caption to 2,000 characters', () => {
    expect(checkSupportMessage('  ', { hasPhoto: true })).toEqual({ ok: true, body: '' });
    expect(checkSupportMessage(' Look ', { hasPhoto: true })).toEqual({ ok: true, body: 'Look' });
    expect(checkSupportMessage('a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1), { hasPhoto: true }).ok).toBe(false);
    expect(checkSupportMessage('', { hasPhoto: false }).ok).toBe(false);
  });

  // The picker refuses early what the server would refuse after the upload.
  it('takes the pictures the server can read, up to the staged upload\'s cap', () => {
    expect(SUPPORT_PHOTO_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(SUPPORT_PHOTO_MAX_BYTES).toBe(TEMPORARY_MEDIA_UPLOAD_LIMITS.maxBytesByKind.image);
    expect(isSupportPhotoType('image/jpg')).toBe(true);
    expect(isSupportPhotoType('IMAGE/PNG; charset=binary')).toBe(true);
    expect(isSupportPhotoType('image/heic')).toBe(false);
    expect(supportPhotoPickRefusal({ type: 'image/png', size: 1024 })).toBeNull();
    expect(supportPhotoPickRefusal({ type: 'image/png', size: null })).toBeNull();
    expect(supportPhotoPickRefusal({ type: 'image/heic', size: 1024 })).toBe(SUPPORT_REFUSAL_WORDS.PHOTO_UNREADABLE);
    expect(supportPhotoPickRefusal({ type: 'image/jpeg', size: SUPPORT_PHOTO_MAX_BYTES + 1 })).toBe(SUPPORT_REFUSAL_WORDS.PHOTO_TOO_LARGE);
  });

  it('reads a send\'s photo only as a path staged in uploads', () => {
    expect(readSupportPhotoRequest({ storagePath: ' uploads/u1/abc-photo.jpg ' })).toEqual({ storagePath: 'uploads/u1/abc-photo.jpg' });
    expect(readSupportPhotoRequest({ storagePath: 'support_attachments/u1/x.webp' })).toBeNull();
    expect(readSupportPhotoRequest({ storagePath: 'uploads/u1/../u2/x.jpg' })).toBeNull();
    expect(readSupportPhotoRequest({ storagePath: 42 })).toBeNull();
    expect(readSupportPhotoRequest('uploads/u1/x.jpg')).toBeNull();
  });

  it('reads a photo message, with or without a caption, and drops one it cannot draw', () => {
    expect(readSupportMessage({ ...photoMessage, attachment: { ...photo } })).toEqual(photoMessage);
    expect(readSupportMessage({ ...photoMessage, body: 'Caption' })?.body).toBe('Caption');
    // A link Storage could not sign reads as none: the photo says it could not be loaded.
    expect(readSupportPhoto({ ...photo, previewUrl: null, url: 'javascript:alert(1)' }))
      .toMatchObject({ previewUrl: null, url: null, width: 1080 });
    expect(readSupportPhoto({ ...photo, width: 0 })).toBeNull();
    expect(readSupportPhoto({ ...photo, kind: 'video' })).toBeNull();
    expect(readSupportMessage({ ...photoMessage, attachment: { ...photo, height: -1 } })).toBeNull();
    expect(readSupportMessage({ ...photoMessage, deletedAt: '2026-11-21T09:05:00Z', attachment: photo }))
      .toMatchObject({ body: null, attachment: null });
  });

  it('quotes a photo as "📷 Photo", or with its caption, and says so in a list and an alert', () => {
    expect(supportQuoteOf(photoMessage)).toMatchObject({ hasPhoto: true, deleted: false, body: null });
    expect(supportQuoteText({ body: null, deleted: false, hasPhoto: true })).toBe('📷 Photo');
    expect(supportQuoteText({ body: 'The error', deleted: false, hasPhoto: true })).toBe('📷 The error');
    expect(supportQuoteText({ body: null, deleted: true, hasPhoto: false })).toBe(SUPPORT_WORDS.deleted);
    expect(readSupportMessage({ ...staffMessage, replyTo: { id: 'p1', author: 'user', body: null, deleted: false, hasPhoto: true } })?.replyTo)
      .toEqual({ id: 'p1', author: 'user', body: null, deleted: false, hasPhoto: true });
    expect(supportPreviewText(null, true)).toBe('📷 Photo');
    expect(supportPreviewText(' Where\nis it ', true)).toBe('📷 Where is it');
    expect(supportPreviewText('Plain', false)).toBe('Plain');
    expect(supportReplyAlertWords('', true).body).toBe('📷 Photo');
  });

  it('draws a photo in its shape, a tall one cut, a tiny one at the smallest size', () => {
    const bounds = { maxWidth: 288, maxHeight: 360 };
    expect(supportPhotoFrame({ width: 1600, height: 900 }, bounds)).toEqual({ width: 288, height: 162, cropped: false });
    expect(supportPhotoFrame({ width: 1080, height: 2400 }, bounds)).toEqual({ width: 288, height: 360, cropped: true });
    expect(supportPhotoFrame({ width: 40, height: 40 }, bounds)).toEqual({ width: 120, height: 120, cropped: false });
    expect(supportPhotoFrame({ width: 4000, height: 300 }, bounds)).toEqual({ width: 288, height: 60, cropped: true });
  });

  it('keeps the links a thread already drew while they last, so a read does not fetch a photo again', () => {
    const now = Date.parse('2026-11-21T10:00:00.000Z');
    const fresh = { ...photo, previewUrl: 'https://storage.example/preview.webp?token=b', url: 'https://storage.example/full.webp?token=b', expiresAt: '2026-11-21T13:00:00.000Z' };
    const next = [{ ...photoMessage, attachment: fresh }, userMessage];
    expect(withStableSupportPhotoLinks([photoMessage], next, now)[0].attachment).toBe(photo);
    // Close to its end, a link gives way to the new one.
    const late = now + Date.parse(photo.expiresAt) - now - SUPPORT_PHOTO_LINK_RENEW_BEFORE_MS + 1;
    expect(withStableSupportPhotoLinks([photoMessage], next, late)[0].attachment).toBe(fresh);
    // A link that could not be signed is never kept over a new one.
    const unsigned = { ...photoMessage, attachment: { ...photo, previewUrl: null } };
    expect(withStableSupportPhotoLinks([unsigned], next, now)[0].attachment).toBe(fresh);
    expect(withStableSupportPhotoLinks([], next, now)).toEqual(next);
  });

  it('keeps a photo on its way with its message, and drops it with a delete', () => {
    const pending = startPendingSupportMessage([], {
      clientMessageId: 'msg:photo-001',
      body: '',
      now: '2026-11-21T11:00:00.000Z',
      photo: { localUri: 'blob:local-1', width: 900, height: 1600 },
    });
    expect(pending[0]).toMatchObject({ body: '', photo: { localUri: 'blob:local-1', width: 900, height: 1600 } });
    expect(startPendingSupportMessage([], { clientMessageId: 'msg:text-001', body: 'Hi', now: '2026-11-21T11:00:00.000Z' })[0].photo).toBeNull();
    expect(supportDeletedMessage(photoMessage, '2026-11-21T11:00:00.000Z')).toMatchObject({ attachment: null, body: null });
    expect(canEditSupportMessage(photoMessage, 'user', Date.parse(photoMessage.createdAt))).toBe(false);
    expect(canEditSupportMessage({ ...photoMessage, body: 'Caption' }, 'user', Date.parse(photoMessage.createdAt))).toBe(true);
  });
});

it('names the support mail the web names', () => {
  expect(SUPPORT_EMAIL).toBe(siteConfig.supportEmail);
});

describe('settling, failing and letting go of messages on their way', () => {
  const pending = (clientMessageId: string, overrides: Partial<SupportPendingMessage> = {}): SupportPendingMessage => ({
    clientMessageId,
    body: 'On its way',
    createdAt: '2026-11-21T09:00:00.000Z',
    state: 'sending',
    replyTo: null,
    photo: null,
    ...overrides,
  });

  it('settles every copy on its way or not sent whose message a read shows kept under its client id', () => {
    const waiting = [pending('msg:kept-0000001', { state: 'failed' }), pending('msg:still-0000002')];
    const settled = withoutKeptPendingMessages(waiting, [
      message({ id: 'm9', clientMessageId: 'msg:kept-0000001' }),
      message({ id: 'm10', author: 'staff', clientMessageId: null }),
    ]);
    expect(settled.map((item) => item.clientMessageId)).toEqual(['msg:still-0000002']);
    // Nothing kept: the same list, so a screen draws nothing anew.
    expect(withoutKeptPendingMessages(waiting, [message({ id: 'm11' })])).toBe(waiting);
  });

  it('lets a quote that was deleted go from a message refused for it, so a retry sends it on its own', () => {
    const quoted = { id: 'm2', author: 'staff' as const, body: 'Which one?', deleted: false, hasPhoto: false };
    const [refused] = failPendingSupportMessage([pending('msg:reply-0000001', { replyTo: quoted })], 'msg:reply-0000001', 'REPLY_NOT_FOUND');
    expect(refused).toMatchObject({ state: 'failed', replyTo: null });
    const [lost] = failPendingSupportMessage([pending('msg:reply-0000002', { replyTo: quoted })], 'msg:reply-0000002', null);
    expect(lost).toMatchObject({ state: 'failed', replyTo: quoted });
  });

  it('stages a photo anew only for a refusal of the photo itself', () => {
    for (const code of ['PHOTO_NOT_FOUND', 'PHOTO_UNREADABLE', 'PHOTO_TOO_LARGE']) expect(isSupportPhotoRefusal(code)).toBe(true);
    for (const code of ['REPLY_NOT_FOUND', 'RATE_LIMITED', null, undefined]) expect(isSupportPhotoRefusal(code)).toBe(false);
  });
});

describe('a message as both clients read it', () => {
  it('reads the client id the writer sent it under, and nothing that is not one', () => {
    const base = { id: 'm1', author: 'user', body: 'Hi', createdAt: '2026-11-21T09:00:00Z' };
    expect(readSupportMessage({ ...base, clientMessageId: 'msg:abc-12345' })?.clientMessageId).toBe('msg:abc-12345');
    expect(readSupportMessage(base)?.clientMessageId).toBeNull();
    expect(readSupportMessage({ ...base, clientMessageId: 42 })?.clientMessageId).toBeNull();
  });
});

describe('an account\'s initials', () => {
  it('takes the first letter of the first two words, whole when it is an emoji or a flag', () => {
    expect(supportInitials('Asha Rao')).toBe('AR');
    expect(supportInitials('@asha')).toBe('A');
    expect(supportInitials('😀 Bob')).toBe('😀B');
    expect(supportInitials('Bob 😀')).toBe('B😀');
    expect(supportInitials('🇮🇳 India')).toBe('🇮🇳I');
    expect(supportInitials('   ')).toBe('?');
  });
});
