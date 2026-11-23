/**
 * Help & support conversations: the rules the server and both clients share.
 * An account has one conversation with support, which the operator answers
 * from /admin/support; the account is told of a reply by an alert
 * (`support_reply`) that opens `/support`.
 *
 * It works as a chat app does (owner, 2026-11-22: "make the functionalities
 * close to whatsapp as much as possible"): new messages arrive while the
 * thread is open, a sent message shows one tick and two once the other side
 * has read it, "typing…" shows while the other side writes, a message can be
 * answered with a quote of it, reacted to, edited for 15 minutes and deleted
 * for everyone for 48 hours, and the thread is drawn in days, with the
 * messages one side sent in a row grouped and the first unread one marked.
 * A message may carry one photo, with or without a caption (owner,
 * 2026-11-22: "Yes, build photos"): the account's is staged like any upload
 * and named in the send, the console's goes with the send, and every client
 * sees only signed links to the server's copies, which last a few hours.
 *
 * Imported by the server (`src/lib/support-conversations.ts` and its route
 * adapters), the web's `/support` page and console, and the app's
 * `app/support.tsx`, so it stays free of React Native, Expo and Node imports.
 */

/** The longest message, in characters as people count them (code points). */
export const SUPPORT_MESSAGE_MAX_LENGTH = 2000;

/** Where the composers start counting down, so a short message shows no counter. */
export const SUPPORT_MESSAGE_COUNTER_FROM = 1800;

/** The most messages a conversation read returns: the newest, oldest first. */
export const SUPPORT_THREAD_MESSAGE_LIMIT = 200;

/** Where an alert about a reply leads, in the app and on the web. */
export const SUPPORT_CONVERSATION_PATH = '/support';

/** The support mail: the way in without an account, and the fallback (the web's `siteConfig.supportEmail`). */
export const SUPPORT_EMAIL = 'info@magicbooklet.com';

/** A message can be edited this long after it was sent (`edit_support_message`). */
export const SUPPORT_EDIT_WINDOW_MINUTES = 15;

/** A message can be deleted for everyone this long after it was sent (`delete_support_message`). */
export const SUPPORT_DELETE_WINDOW_HOURS = 48;

/** "typing…" lasts this long past a side's latest ping (`set_support_conversation_typing`). */
export const SUPPORT_TYPING_SECONDS = 8;

/** A composer says "typing" at most this often while its text changes: well inside the server's 8 seconds. */
export const SUPPORT_TYPING_PING_MS = 3000;

/**
 * How often an open thread asks for news: every 3 s while something changed
 * in the last minute; every 5 s for the next four, which is inside the 8 s a
 * "typing…" lasts, so the other side's typing is never missed in a
 * conversation that is going on; and every 20 s once it has been quiet for
 * five minutes, for a page left open while waiting for an answer.
 */
export const SUPPORT_POLL_ACTIVE_MS = 3000;
export const SUPPORT_POLL_WARM_MS = 5000;
export const SUPPORT_POLL_COLD_MS = 20_000;
export const SUPPORT_POLL_WARM_AFTER_MS = 60_000;
export const SUPPORT_POLL_COLD_AFTER_MS = 5 * 60_000;

/**
 * The pictures a photo may be sent as: what the server can read and re-encode.
 * HEIC is not among them (the server's image library cannot read it); the
 * app's photo picker hands over JPEG, and a browser names what it picks.
 */
export const SUPPORT_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** The largest photo a person may pick: the staged upload's own cap for a picture. */
export const SUPPORT_PHOTO_MAX_BYTES = 25 * 1024 * 1024;

/** The console's photo goes with the send, under the host's request cap: the browser shrinks it to this side first. */
export const SUPPORT_CONSOLE_PHOTO_MAX_SIDE = 2560;
export const SUPPORT_CONSOLE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

/** A photo's links are taken anew from a read once they have less than this left to live. */
export const SUPPORT_PHOTO_LINK_RENEW_BEFORE_MS = 15 * 60_000;

/** The quick reactions both clients offer, and the only ones the database keeps. */
export const SUPPORT_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** The web composer's emoji panel: the common ones, as a chat app's first page shows them. */
export const SUPPORT_EMOJI_PANEL = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🙂', '😉', '😊', '😍',
  '🥰', '😘', '😎', '🤩', '🤔', '🤨', '😐', '🙄', '😏', '😮',
  '😢', '😭', '😤', '😡', '🥺', '😴', '🤯', '🥳', '😇', '🤗',
  '👍', '👎', '👏', '🙌', '🙏', '👌', '✌️', '🤞', '💪', '👋',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '⭐', '🎉',
  '✅', '❌', '⚠️', '❓', '💯', '🎨', '📷', '🎬', '💡', '⏳',
] as const;

export type SupportMessageAuthor = 'user' | 'staff';
export type SupportConversationStatus = 'open' | 'resolved';
export type SupportReactionEmoji = (typeof SUPPORT_REACTION_EMOJIS)[number];

export type SupportReaction = {
  author: SupportMessageAuthor;
  emoji: SupportReactionEmoji;
};

/** The message a reply quotes, as it is now: its text, that it is a photo, or that it was deleted. */
export type SupportQuotedMessage = {
  id: string;
  author: SupportMessageAuthor;
  body: string | null;
  deleted: boolean;
  hasPhoto: boolean;
};

/**
 * A message's photo, as clients draw it: signed links to the server's two
 * copies, which stop working at `expiresAt`, the size the picture is drawn at
 * (upright), and a thumbhash to draw while the preview loads. A link is null
 * when Storage could not sign it (its copy is gone): the message stays, and
 * the client says the photo could not be loaded.
 */
export type SupportPhoto = {
  kind: 'image';
  /** The 720 px copy the thread draws. */
  previewUrl: string | null;
  /** The picture at up to 2560 px, for the full-screen view. */
  url: string | null;
  width: number;
  height: number;
  thumbhash: string | null;
  expiresAt: string;
};

export type SupportMessage = {
  id: string;
  author: SupportMessageAuthor;
  /**
   * The id the reader's own client sent it under, by which a copy still
   * drawn as on its way (its answer lost, or a read faster than the answer)
   * is settled; null for the other side's messages and one sent without one.
   */
  clientMessageId: string | null;
  /** The text, or a photo's caption; null for a photo without one, and once its author deleted it for everyone. */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  replyTo: SupportQuotedMessage | null;
  reactions: SupportReaction[];
  /** The photo it carries; null for text alone and once deleted. */
  attachment: SupportPhoto | null;
};

/** A conversation's id and status: what a send answers with. */
export type SupportConversationRef = {
  id: string;
  status: SupportConversationStatus;
};

export type SupportConversationSummary = SupportConversationRef & {
  /** When the account last read the thread: support's messages after it are unread to the account. */
  userLastReadAt: string | null;
  /** When support last read the thread: the account's messages up to it show two ticks. */
  staffLastReadAt: string | null;
  /** The account is writing (the console's "typing…"). */
  userTyping: boolean;
  /** Support is writing (the account's "typing…"). */
  staffTyping: boolean;
};

/** `GET /api/support/conversation`: the account's conversation, or none yet. */
export type SupportConversationResponse = {
  success: true;
  conversation: SupportConversationSummary | null;
  messages: SupportMessage[];
};

/**
 * `POST /api/support/conversation`. `clientMessageId` is the client's own id
 * for the message: a send retried with the same id is kept once.
 * `replyToMessageId` quotes a message of the conversation. `photo` names a
 * picture the account staged in `uploads` (`/api/uploads/media/sign`, then
 * finalize): the send claims it, and `body` is then its caption, which may be
 * empty.
 */
export type SupportMessageRequest = {
  body: string;
  clientMessageId: string;
  replyToMessageId?: string | null;
  photo?: SupportPhotoRequest | null;
};

/** A staged photo, by the storage path its upload answered with (`uploads/<account>/…`). */
export type SupportPhotoRequest = { storagePath: string };

export type SupportMessageResponse = {
  success: true;
  message: SupportMessage;
  conversation: SupportConversationRef;
};

/** `PATCH /api/support/messages/:messageId`: the new text of one's own message. */
export type SupportMessageEditRequest = { body: string };

/** `POST /api/support/messages/:messageId/reaction`: one's reaction, or null to take it away. */
export type SupportReactionRequest = { emoji: SupportReactionEmoji | null };

/** `POST /api/support/conversation/typing`. */
export type SupportTypingRequest = { typing: boolean };

/** The answer to an edit, a delete or a reaction: the message as it now is. */
export type SupportMessageUpdateResponse = {
  success: true;
  message: SupportMessage;
};

/**
 * `POST /api/support/conversation/read`'s body: the newest message the reader
 * was shown, so one kept after its last look is not marked read unseen.
 * Without it (an app from before 2026-11-23 sends no body) the whole thread is.
 */
export type SupportReadRequest = { upToMessageId?: string | null };

/** `POST /api/support/conversation/read`: both sides' read times after the read. */
export type SupportReadResponse = {
  success: true;
  userLastReadAt: string | null;
  staffLastReadAt: string | null;
};

export type SupportMessageRefusalCode =
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'INVALID_CLIENT_MESSAGE_ID'
  | 'REPLY_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_YOUR_MESSAGE'
  | 'MESSAGE_DELETED'
  | 'EDIT_TOO_LATE'
  | 'DELETE_TOO_LATE'
  | 'INVALID_REACTION'
  | 'PHOTO_NOT_FOUND'
  | 'PHOTO_UNREADABLE'
  | 'PHOTO_TOO_LARGE';

export const SUPPORT_MESSAGE_EMPTY = 'Write a message first.';
export const SUPPORT_MESSAGE_TOO_LONG = 'That message is over 2,000 characters. Shorten it, or send it in two parts.';
export const SUPPORT_CLIENT_MESSAGE_ID_INVALID = 'This message could not be sent. Try again.';

/** The words of every refusal the support routes answer with. */
export const SUPPORT_REFUSAL_WORDS: Record<SupportMessageRefusalCode, string> = {
  EMPTY_MESSAGE: SUPPORT_MESSAGE_EMPTY,
  MESSAGE_TOO_LONG: SUPPORT_MESSAGE_TOO_LONG,
  INVALID_CLIENT_MESSAGE_ID: SUPPORT_CLIENT_MESSAGE_ID_INVALID,
  REPLY_NOT_FOUND: 'The message you replied to is no longer there.',
  MESSAGE_NOT_FOUND: 'That message is no longer there.',
  NOT_YOUR_MESSAGE: 'You can only change your own messages.',
  MESSAGE_DELETED: 'That message was deleted.',
  EDIT_TOO_LATE: `A message can be edited for ${SUPPORT_EDIT_WINDOW_MINUTES} minutes after it is sent.`,
  DELETE_TOO_LATE: `A message can be deleted for everyone for ${SUPPORT_DELETE_WINDOW_HOURS} hours after it is sent.`,
  INVALID_REACTION: 'Choose one of the reactions.',
  PHOTO_NOT_FOUND: 'That photo did not finish uploading. Choose it again.',
  PHOTO_UNREADABLE: 'That file could not be read as a photo. Send a JPEG, PNG, WebP or GIF.',
  PHOTO_TOO_LARGE: 'That photo is over 25 MB. Choose a smaller one.',
};

/** The words both clients draw, so the web and the app say the same. */
export const SUPPORT_WORDS = {
  title: 'Message support',
  supportName: 'Magicbooklet support',
  intro: 'Ask about a creation, a purchase or your account. We reply here, and you get a notification when we do.',
  privacyNote: 'Only you and the Magicbooklet team can read this conversation.',
  emptyTitle: 'How can we help?',
  emptyBody: 'Tell us what happened and where: the creation, the purchase or the screen. The more detail, the faster we can fix it.',
  placeholder: 'Message',
  send: 'Send',
  sending: 'Sending…',
  notSent: 'Not sent. Tap to try again.',
  loadFailed: 'Your messages could not be loaded. Check your connection, then try again.',
  sendFailed: 'Your message was not sent. Check your connection, then try again.',
  actionFailed: 'That did not go through. Check your connection, then try again.',
  resolved: 'We marked this as resolved. Write again any time and the conversation reopens.',
  replyTime: 'Usually replies within a day',
  typing: 'typing…',
  today: 'Today',
  yesterday: 'Yesterday',
  edited: 'Edited',
  deleted: 'This message was deleted',
  youDeleted: 'You deleted this message',
  you: 'You',
  reply: 'Reply',
  copy: 'Copy',
  copied: 'Copied',
  edit: 'Edit',
  delete: 'Delete',
  react: 'React',
  moreActions: 'Message actions',
  editing: 'Edit message',
  cancelReply: 'Cancel reply',
  cancelEdit: 'Cancel edit',
  save: 'Save',
  emoji: 'Emoji',
  jumpToLatest: 'Jump to the latest message',
  deleteTitle: 'Delete for everyone?',
  deleteBody: 'The message is removed from this conversation for both of you.',
  deleteConfirm: 'Delete for everyone',
  signInTitle: 'Sign in to message support',
  signInBody: 'Messages to support are kept with your account. You can also email us without signing in.',
  emailInstead: 'Email us instead',
  photo: 'Photo',
  attachPhoto: 'Attach a photo',
  addCaption: 'Add a caption',
  removePhoto: 'Remove photo',
  openPhoto: 'Open photo',
  closePhoto: 'Close photo',
  photoLoadFailed: 'The photo could not be loaded.',
  photoTryAgain: 'Tap to try again',
  photoGone: 'This photo is no longer on your phone. Delete the message and choose the photo again.',
  tryAgain: 'Try again',
  notSentActions: 'Your message was not sent',
} as const;

/**
 * Up to two letters of a name for its round avatar: the first of each of its
 * first two words, whole even when one is an emoji or a flag.
 */
export function supportInitials(name: string): string {
  const Segmenter = typeof Intl === 'object' ? Intl.Segmenter : undefined;
  const first = (word: string): string => {
    if (Segmenter) {
      for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(word)) return segment;
      return '';
    }
    return Array.from(word)[0] ?? '';
  };
  const letters = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(first).join('');
  return (letters || '?').toUpperCase();
}

/** "1 unread message", "3 unread messages": the divider above the first unread one. */
export function supportUnreadWords(count: number): string {
  return `${count} unread message${count === 1 ? '' : 's'}`;
}

/** A message's text on one line, a photo said as "📷 Photo" or "📷 caption", as a list or an alert shows it. */
export function supportPreviewText(body: string | null, hasPhoto: boolean): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!hasPhoto) return text;
  return `📷 ${text || SUPPORT_WORDS.photo}`;
}

/** What a reply's alert says: who answered, and the start of the answer. */
export function supportReplyAlertWords(replyBody: string, hasPhoto = false) {
  const text = supportPreviewText(replyBody, hasPhoto);
  const characters = Array.from(text);
  return {
    title: 'Support replied',
    body: characters.length > 140 ? `${characters.slice(0, 139).join('')}…` : text,
  };
}

/** Characters as people count them (code points), once trimmed. */
export function supportMessageLength(text: string): number {
  return Array.from(text.trim()).length;
}

/**
 * The rule a message is sent by: some text, at most 2,000 characters once
 * trimmed; with a photo the text is its caption and may be empty. The server
 * refuses by it; the composers use it to hold Send.
 */
export function checkSupportMessage(
  text: unknown,
  { hasPhoto = false }: { hasPhoto?: boolean } = {},
): { ok: true; body: string } | { ok: false; code: SupportMessageRefusalCode; error: string } {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body && !hasPhoto) {
    return { ok: false, code: 'EMPTY_MESSAGE', error: SUPPORT_MESSAGE_EMPTY };
  }
  if (Array.from(body).length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return { ok: false, code: 'MESSAGE_TOO_LONG', error: SUPPORT_MESSAGE_TOO_LONG };
  }
  return { ok: true, body };
}

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9:_-]{8,100}$/;

export function isSupportClientMessageId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_MESSAGE_ID_PATTERN.test(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A message id as the routes take it. */
export function isSupportMessageId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isSupportReactionEmoji(value: unknown): value is SupportReactionEmoji {
  return typeof value === 'string' && (SUPPORT_REACTION_EMOJIS as readonly string[]).includes(value);
}

/** A picture type a photo may be sent as (`image/jpg` read as JPEG). */
export function isSupportPhotoType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const type = value.split(';')[0].trim().toLowerCase();
  return (SUPPORT_PHOTO_TYPES as readonly string[]).includes(type === 'image/jpg' ? 'image/jpeg' : type);
}

/**
 * Whether a picked file may go as a photo: a refusal's words for a type the
 * server cannot read or a file over the cap, null when it may. A file whose
 * size the picker did not say is let through; the server judges it.
 */
export function supportPhotoPickRefusal(file: { type?: string | null; size?: number | null }): string | null {
  if (!isSupportPhotoType(file.type)) return SUPPORT_REFUSAL_WORDS.PHOTO_UNREADABLE;
  if (typeof file.size === 'number' && file.size > SUPPORT_PHOTO_MAX_BYTES) return SUPPORT_REFUSAL_WORDS.PHOTO_TOO_LARGE;
  return null;
}

/** Reads a send's `photo`: a staged path inside `uploads`, or null for none or one that is not. */
export function readSupportPhotoRequest(value: unknown): SupportPhotoRequest | null {
  if (!value || typeof value !== 'object') return null;
  const storagePath = (value as Record<string, unknown>).storagePath;
  if (typeof storagePath !== 'string') return null;
  const path = storagePath.trim();
  if (!path.startsWith('uploads/') || path.length > 500 || path.includes('..')) return null;
  return { storagePath: path };
}

/**
 * A new id for a message about to be sent, kept with it through every retry.
 * `crypto.randomUUID` where the runtime has it (browsers; not every Hermes),
 * else the time and a random tail, which is unique enough for one account.
 * `null` stands for a runtime without it (an `undefined` would take the default).
 */
export function createSupportClientMessageId(
  randomUUID: (() => string) | null = globalThis.crypto?.randomUUID?.bind(globalThis.crypto) ?? null,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  if (randomUUID) {
    return `msg:${randomUUID()}`;
  }
  const tail = Math.floor(random() * 2 ** 48).toString(36).padStart(10, '0');
  return `msg:${now().toString(36)}:${tail}`;
}

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/** Whether the viewer may still change the text of a message (its own, kept, under 15 minutes old). */
export function canEditSupportMessage(message: SupportMessage, viewer: SupportMessageAuthor, now: number = Date.now()): boolean {
  if (message.author !== viewer || message.deletedAt || message.body === null) return false;
  const sent = timeOf(message.createdAt);
  return Number.isFinite(sent) && now - sent < SUPPORT_EDIT_WINDOW_MINUTES * 60_000;
}

/** Whether the viewer may still delete a message for everyone (its own, kept, under 48 hours old). */
export function canDeleteSupportMessage(message: SupportMessage, viewer: SupportMessageAuthor, now: number = Date.now()): boolean {
  if (message.author !== viewer || message.deletedAt) return false;
  const sent = timeOf(message.createdAt);
  return Number.isFinite(sent) && now - sent < SUPPORT_DELETE_WINDOW_HOURS * 3_600_000;
}

/** Whether a message can be answered or reacted to: anything not deleted. */
export function canReactToSupportMessage(message: SupportMessage): boolean {
  return !message.deletedAt;
}

export type SupportReceipt = 'sent' | 'read';

/**
 * The ticks under the viewer's own message: one once it is kept, two once the
 * other side has read the thread past it. None on the other side's messages
 * or a deleted one.
 */
export function supportMessageReceipt(
  message: SupportMessage,
  conversation: Pick<SupportConversationSummary, 'userLastReadAt' | 'staffLastReadAt'> | null,
  viewer: SupportMessageAuthor,
): SupportReceipt | null {
  if (message.author !== viewer || message.deletedAt) return null;
  const readAt = timeOf(viewer === 'user' ? conversation?.staffLastReadAt : conversation?.userLastReadAt);
  const sent = timeOf(message.createdAt);
  return Number.isFinite(readAt) && Number.isFinite(sent) && readAt >= sent ? 'read' : 'sent';
}

/**
 * The other side's messages the viewer has not read: those after its read
 * time (all of them before its first read). Deleted ones do not count.
 */
export function supportUnreadMessages(
  messages: readonly SupportMessage[],
  viewer: SupportMessageAuthor,
  lastReadAt: string | null,
): SupportMessage[] {
  const readAt = timeOf(lastReadAt);
  return messages.filter((message) => {
    if (message.author === viewer || message.deletedAt) return false;
    if (!Number.isFinite(readAt)) return true;
    const sent = timeOf(message.createdAt);
    return Number.isFinite(sent) && sent > readAt;
  });
}

/** The other side is writing now. */
export function supportOtherSideTyping(
  conversation: Pick<SupportConversationSummary, 'userTyping' | 'staffTyping'> | null,
  viewer: SupportMessageAuthor,
): boolean {
  if (!conversation) return false;
  return viewer === 'user' ? conversation.staffTyping : conversation.userTyping;
}

/** A local calendar day, for drawing a thread in days. */
export function supportDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * The label of a day in the thread: Today, Yesterday, the weekday within the
 * last week, else the date (with the year when it is not this year).
 */
export function supportDayLabel(value: string, now: Date = new Date(), locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (daysAgo <= 0) return SUPPORT_WORDS.today;
  if (daysAgo === 1) return SUPPORT_WORDS.yesterday;
  if (daysAgo < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The time inside a bubble: "9:41 AM". */
export function supportClockLabel(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** What a quote of a message says: its text on one line, "📷 Photo" or "📷 caption", or that it was deleted. */
export function supportQuoteText(quoted: Pick<SupportQuotedMessage, 'body' | 'deleted'> & { hasPhoto?: boolean }): string {
  if (quoted.deleted) return SUPPORT_WORDS.deleted;
  if (quoted.hasPhoto) return supportPreviewText(quoted.body, true);
  if (quoted.body === null) return SUPPORT_WORDS.deleted;
  return quoted.body.replace(/\s+/g, ' ').trim();
}

/** The quote of a message for a reply about to be sent. */
export function supportQuoteOf(message: SupportMessage): SupportQuotedMessage {
  return {
    id: message.id,
    author: message.author,
    body: message.body,
    deleted: Boolean(message.deletedAt),
    hasPhoto: Boolean(message.attachment),
  };
}

/**
 * The size a photo is drawn at in the thread: as wide as it fits (never wider
 * than its own pixels, never narrower than `minSide`), as tall as its shape
 * says, and cut to `maxHeight` when it is taller, or to half of `minSide`
 * when it is a thin strip (`cropped`: drawn to fill the frame), as a chat app
 * draws a tall screenshot or a panorama.
 */
export function supportPhotoFrame(
  photo: Pick<SupportPhoto, 'width' | 'height'>,
  { maxWidth, maxHeight, minSide = 120 }: { maxWidth: number; maxHeight: number; minSide?: number },
): { width: number; height: number; cropped: boolean } {
  const sourceWidth = photo.width > 0 ? photo.width : 1;
  const sourceHeight = photo.height > 0 ? photo.height : 1;
  const width = Math.round(Math.max(Math.min(maxWidth, sourceWidth), Math.min(minSide, maxWidth)));
  const height = Math.round((width * sourceHeight) / sourceWidth);
  const minHeight = Math.round(Math.min(minSide, maxHeight) / 2);
  if (height > maxHeight) return { width, height: maxHeight, cropped: true };
  if (height < minHeight) return { width, height: minHeight, cropped: true };
  return { width, height, cropped: false };
}

/**
 * The thread with the photos' links it already had, wherever those still have
 * `SUPPORT_PHOTO_LINK_RENEW_BEFORE_MS` to live. Every read signs new links, and
 * a picture whose address changes is fetched again: keeping the first ones
 * means a thread read every few seconds fetches each picture once.
 */
export function withStableSupportPhotoLinks(
  previous: readonly SupportMessage[],
  next: readonly SupportMessage[],
  now: number = Date.now(),
): SupportMessage[] {
  const kept = new Map<string, SupportPhoto>();
  for (const message of previous) {
    if (!message.attachment?.previewUrl || !message.attachment.url) continue;
    const expires = timeOf(message.attachment.expiresAt);
    if (Number.isFinite(expires) && expires - now > SUPPORT_PHOTO_LINK_RENEW_BEFORE_MS) kept.set(message.id, message.attachment);
  }
  if (kept.size === 0) return [...next];
  return next.map((message) => {
    const photo = message.attachment ? kept.get(message.id) : undefined;
    return photo ? { ...message, attachment: photo } : message;
  });
}

/** Who wrote a quoted message, as the viewer reads it. */
export function supportQuoteAuthorName(
  author: SupportMessageAuthor,
  viewer: SupportMessageAuthor,
  accountName = 'Account',
): string {
  if (author === viewer) return SUPPORT_WORDS.you;
  return author === 'staff' ? SUPPORT_WORDS.supportName : accountName;
}

/** What stands in a deleted message's place, as the viewer reads it. */
export function supportDeletedWords(message: Pick<SupportMessage, 'author'>, viewer: SupportMessageAuthor): string {
  return message.author === viewer ? SUPPORT_WORDS.youDeleted : SUPPORT_WORDS.deleted;
}

export type SupportTextSegment =
  | { kind: 'text'; text: string; start: number }
  | { kind: 'link'; text: string; href: string; start: number };

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi;
const LINK_TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** A message's text with its web addresses marked, so both clients can draw them as links. `start` keys a segment. */
export function supportTextSegments(text: string): SupportTextSegment[] {
  const segments: SupportTextSegment[] = [];
  let index = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = raw.replace(LINK_TRAILING_PUNCTUATION, '');
    if (!trimmed) continue;
    if (start > index) segments.push({ kind: 'text', text: text.slice(index, start), start: index });
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    segments.push({ kind: 'link', text: trimmed, href, start });
    index = start + trimmed.length;
  }
  if (index < text.length) segments.push({ kind: 'text', text: text.slice(index), start: index });
  return segments;
}

/**
 * A photo on its way: the picture on the device (an object URL on the web, a
 * file URI in the app), drawn until the server's copy arrives, and its size
 * when the picker said it.
 */
export type SupportPendingPhoto = {
  localUri: string;
  width: number | null;
  height: number | null;
};

/**
 * A message the viewer wrote that the server has not kept yet: on its way, or
 * not sent and waiting for a retry with the same id.
 */
export type SupportPendingMessage = {
  clientMessageId: string;
  body: string;
  createdAt: string;
  state: 'sending' | 'failed';
  replyTo: SupportQuotedMessage | null;
  photo: SupportPendingPhoto | null;
};

/**
 * The waiting list as a send starts. A retry keeps the message where it was
 * written, with its first time; a new message goes last.
 */
export function startPendingSupportMessage(
  pending: readonly SupportPendingMessage[],
  {
    clientMessageId,
    body,
    now,
    replyTo = null,
    photo = null,
  }: {
    clientMessageId: string;
    body: string;
    now: string;
    replyTo?: SupportQuotedMessage | null;
    photo?: SupportPendingPhoto | null;
  },
): SupportPendingMessage[] {
  const existing = pending.find((item) => item.clientMessageId === clientMessageId);
  if (existing) {
    return pending.map((item) => (item.clientMessageId === clientMessageId ? { ...item, state: 'sending' } : item));
  }
  return [...pending, { clientMessageId, body, createdAt: now, state: 'sending', replyTo, photo }];
}

/**
 * A send that did not go through: kept, with its text, for a retry. Refused
 * because the message it quotes was deleted (REPLY_NOT_FOUND), it lets the
 * quote go, so the retry sends it on its own rather than being refused again.
 */
export function failPendingSupportMessage(
  pending: readonly SupportPendingMessage[],
  clientMessageId: string,
  code: string | null = null,
): SupportPendingMessage[] {
  return pending.map((item) => (item.clientMessageId === clientMessageId
    ? { ...item, state: 'failed', replyTo: code === 'REPLY_NOT_FOUND' ? null : item.replyTo }
    : item));
}

/** A send the server kept, or one not sent that the writer let go: it leaves the waiting list. */
export function settlePendingSupportMessage(
  pending: readonly SupportPendingMessage[],
  clientMessageId: string,
): SupportPendingMessage[] {
  return pending.filter((item) => item.clientMessageId !== clientMessageId);
}

/**
 * The waiting list once a read brought the thread: a message the server kept
 * under its client id is the thread's now, on its way or marked not sent (its
 * answer lost after it was kept), so it is not drawn twice or sent again.
 */
export function withoutKeptPendingMessages(
  pending: readonly SupportPendingMessage[],
  messages: readonly SupportMessage[],
): SupportPendingMessage[] {
  const kept = new Set(messages.map((message) => message.clientMessageId).filter((id): id is string => Boolean(id)));
  if (kept.size === 0 || !pending.some((item) => kept.has(item.clientMessageId))) return pending as SupportPendingMessage[];
  return pending.filter((item) => !kept.has(item.clientMessageId));
}

/** Whether a refusal is about the photo itself: a staged copy is staged anew only then. */
export function isSupportPhotoRefusal(code: string | null | undefined): boolean {
  return code === 'PHOTO_NOT_FOUND' || code === 'PHOTO_UNREADABLE' || code === 'PHOTO_TOO_LARGE';
}

function compareSupportMessages(a: SupportMessage, b: SupportMessage): number {
  // By the instant where both times read as one ("Z" and "+00:00" are the same
  // time), else by the text, which the server writes in one form. A tie keeps
  // the order of arrival (the sort is stable).
  const first = Date.parse(a.createdAt);
  const second = Date.parse(b.createdAt);
  if (!Number.isNaN(first) && !Number.isNaN(second)) return first - second;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/**
 * The thread once the server answered with a message: added at its place by
 * time, or put in place of the copy already there (an edit, a delete, a
 * reaction, or a send a read already brought).
 */
export function withSupportMessage(messages: readonly SupportMessage[], message: SupportMessage): SupportMessage[] {
  if (messages.some((existing) => existing.id === message.id)) {
    return messages.map((existing) => (existing.id === message.id ? message : existing));
  }
  const next = [...messages, message];
  next.sort(compareSupportMessages);
  return next;
}

/**
 * What a press on a reaction does: the viewer's reaction becomes this one, or
 * goes when it already was this one. Answers the reaction to send and the
 * message as it will be once the server agrees, to draw at once.
 */
export function supportReactionToggle(
  message: SupportMessage,
  viewer: SupportMessageAuthor,
  emoji: SupportReactionEmoji,
): { emoji: SupportReactionEmoji | null; message: SupportMessage } {
  const mine = message.reactions.find((reaction) => reaction.author === viewer);
  const next = mine?.emoji === emoji ? null : emoji;
  const others = message.reactions.filter((reaction) => reaction.author !== viewer);
  return {
    emoji: next,
    message: { ...message, reactions: next ? [...others, { author: viewer, emoji: next }] : others },
  };
}

/** A message as an edit will leave it, drawn while the edit is on its way. */
export function supportEditedMessage(message: SupportMessage, body: string, now: string): SupportMessage {
  return { ...message, body, editedAt: now };
}

/** A message as a delete for everyone will leave it, drawn while the delete is on its way. */
export function supportDeletedMessage(message: SupportMessage, now: string): SupportMessage {
  return { ...message, body: null, deletedAt: now, reactions: [], attachment: null };
}

/** The conversation's read times after a read, moved on, never back. */
export function withSupportReadTimes(
  conversation: SupportConversationSummary | null,
  read: Pick<SupportReadResponse, 'userLastReadAt' | 'staffLastReadAt'>,
): SupportConversationSummary | null {
  if (!conversation) return conversation;
  const later = (current: string | null, next: string | null) => {
    if (!next) return current;
    if (!current) return next;
    return timeOf(next) > timeOf(current) ? next : current;
  };
  return {
    ...conversation,
    userLastReadAt: later(conversation.userLastReadAt, read.userLastReadAt),
    staffLastReadAt: later(conversation.staffLastReadAt, read.staffLastReadAt),
  };
}

/** The conversation once a send answered: its status from the send, the rest as it was. */
export function withSupportConversationRef(
  conversation: SupportConversationSummary | null,
  ref: SupportConversationRef,
): SupportConversationSummary {
  return {
    userLastReadAt: null,
    staffLastReadAt: null,
    userTyping: false,
    staffTyping: false,
    ...(conversation && conversation.id === ref.id ? conversation : {}),
    id: ref.id,
    status: ref.status,
  };
}

export type SupportThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string; label: string }
  | {
    kind: 'message';
    key: string;
    message: SupportMessage;
    mine: boolean;
    /** The first of a run of one side's messages: it carries the bubble's tail. */
    startsGroup: boolean;
    endsGroup: boolean;
    receipt: SupportReceipt | null;
  }
  | {
    kind: 'pending';
    key: string;
    pending: SupportPendingMessage;
    startsGroup: boolean;
    endsGroup: boolean;
  };

/**
 * The thread as both clients draw it: a label at each new day, the kept
 * messages in their order, then the viewer's messages still on their way or
 * not sent, in the order written. A divider stands above the first message of
 * the other side's that was unread when the thread opened (`unreadFromId`).
 * A run of one side's messages on one day is a group: its first carries the
 * tail, and a label or the divider starts a new run.
 */
export function supportThreadRows({
  messages,
  pending,
  conversation,
  viewer,
  unreadFromId = null,
  unreadCount = 0,
  now = new Date(),
  locale,
}: {
  messages: readonly SupportMessage[];
  pending: readonly SupportPendingMessage[];
  conversation: Pick<SupportConversationSummary, 'userLastReadAt' | 'staffLastReadAt'> | null;
  viewer: SupportMessageAuthor;
  unreadFromId?: string | null;
  unreadCount?: number;
  now?: Date;
  locale?: string;
}): SupportThreadRow[] {
  type Entry =
    | { kind: 'message'; message: SupportMessage; mine: boolean; createdAt: string; key: string }
    | { kind: 'pending'; pending: SupportPendingMessage; mine: true; createdAt: string; key: string };

  const entries: Entry[] = [
    ...messages.map((message) => ({
      kind: 'message' as const,
      message,
      mine: message.author === viewer,
      createdAt: message.createdAt,
      key: message.id,
    })),
    ...pending.map((item) => ({
      kind: 'pending' as const,
      pending: item,
      mine: true as const,
      createdAt: item.createdAt,
      key: item.clientMessageId,
    })),
  ];

  const rows: SupportThreadRow[] = [];
  let previousDay: string | null = null;
  let previousMine: boolean | null = null;
  let lastBubbleIndex = -1;

  const closeGroup = () => {
    if (lastBubbleIndex < 0) return;
    const last = rows[lastBubbleIndex];
    if (last.kind === 'message' || last.kind === 'pending') rows[lastBubbleIndex] = { ...last, endsGroup: true };
  };

  for (const entry of entries) {
    const day = supportDayKey(entry.createdAt);
    let startsGroup = previousMine !== entry.mine;

    if (day !== previousDay) {
      closeGroup();
      rows.push({ kind: 'day', key: `day:${day}`, label: supportDayLabel(entry.createdAt, now, locale) });
      previousDay = day;
      startsGroup = true;
    }

    if (entry.kind === 'message' && unreadFromId && entry.message.id === unreadFromId && unreadCount > 0) {
      closeGroup();
      rows.push({ kind: 'unread', key: 'unread', label: supportUnreadWords(unreadCount) });
      startsGroup = true;
    }

    if (startsGroup) closeGroup();

    rows.push(entry.kind === 'message'
      ? {
        kind: 'message',
        key: entry.key,
        message: entry.message,
        mine: entry.mine,
        startsGroup,
        endsGroup: false,
        receipt: supportMessageReceipt(entry.message, conversation, viewer),
      }
      : { kind: 'pending', key: entry.key, pending: entry.pending, startsGroup, endsGroup: false });
    lastBubbleIndex = rows.length - 1;
    previousMine = entry.mine;
  }

  closeGroup();
  return rows;
}

/**
 * A short fingerprint of what a thread shows, so a client can tell a read
 * that changed something (and keep asking often) from one that did not.
 */
export function supportThreadSignature(
  conversation: SupportConversationSummary | null,
  messages: readonly SupportMessage[],
): string {
  return JSON.stringify([
    conversation?.status ?? null,
    conversation?.userLastReadAt ?? null,
    conversation?.staffLastReadAt ?? null,
    conversation?.userTyping ?? false,
    conversation?.staffTyping ?? false,
    messages.map((message) => [
      message.id,
      message.editedAt,
      message.deletedAt,
      message.reactions.map((reaction) => `${reaction.author}${reaction.emoji}`).join(','),
    ]),
  ]);
}

/** How long an open thread waits before asking again: often while things move, less the longer it is quiet. */
export function supportPollDelay(lastActivityAt: number, now: number = Date.now()): number {
  const quiet = now - lastActivityAt;
  if (quiet < SUPPORT_POLL_WARM_AFTER_MS) return SUPPORT_POLL_ACTIVE_MS;
  if (quiet < SUPPORT_POLL_COLD_AFTER_MS) return SUPPORT_POLL_WARM_MS;
  return SUPPORT_POLL_COLD_MS;
}

/** Whether a composer should say "typing" again now. */
export function supportShouldPingTyping(lastPingAt: number | null, now: number = Date.now()): boolean {
  return lastPingAt === null || now - lastPingAt >= SUPPORT_TYPING_PING_MS;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function readAuthor(value: unknown): SupportMessageAuthor | null {
  return value === 'user' || value === 'staff' ? value : null;
}

function readReactions(value: unknown): SupportReaction[] {
  if (!Array.isArray(value)) return [];
  const reactions: SupportReaction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const author = readAuthor(record.author);
    if (!author || !isSupportReactionEmoji(record.emoji)) continue;
    // One per side: a second of the same side's is not drawn.
    if (reactions.some((reaction) => reaction.author === author)) continue;
    reactions.push({ author, emoji: record.emoji });
  }
  return reactions;
}

function readQuoted(value: unknown): SupportQuotedMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const author = readAuthor(record.author);
  if (!id || !author) return null;
  const deleted = record.deleted === true;
  const hasPhoto = !deleted && record.hasPhoto === true;
  const body = typeof record.body === 'string' && !deleted ? record.body : null;
  return { id, author, body, deleted: deleted || (body === null && !hasPhoto), hasPhoto };
}

function readDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 20000 ? Math.round(value) : null;
}

function readLink(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

/** Reads a message's photo; null for none, or for one without a size. A link the server could not sign reads as null. */
export function readSupportPhoto(value: unknown): SupportPhoto | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const width = readDimension(record.width);
  const height = readDimension(record.height);
  const expiresAt = readString(record.expiresAt);
  if (record.kind !== 'image' || !width || !height || !expiresAt) return null;
  return {
    kind: 'image',
    previewUrl: readLink(record.previewUrl),
    url: readLink(record.url),
    width,
    height,
    thumbhash: readString(record.thumbhash),
    expiresAt,
  };
}

export function readSupportMessage(value: unknown): SupportMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const createdAt = readString(record.createdAt);
  const author = readAuthor(record.author);
  if (!id || !createdAt || !author) return null;
  const deletedAt = readString(record.deletedAt);
  const body = deletedAt ? null : readString(record.body);
  const attachment = deletedAt ? null : readSupportPhoto(record.attachment);
  // A kept message has text or a photo; only a deleted one may have neither.
  if (!deletedAt && body === null && attachment === null) return null;
  return {
    id,
    author,
    clientMessageId: isSupportClientMessageId(record.clientMessageId) ? record.clientMessageId : null,
    body,
    createdAt,
    editedAt: readString(record.editedAt),
    deletedAt,
    replyTo: readQuoted(record.replyTo),
    reactions: deletedAt ? [] : readReactions(record.reactions),
    attachment,
  };
}

export function readSupportConversationRef(value: unknown): SupportConversationRef | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = readString(record.id);
  const status = record.status === 'open' || record.status === 'resolved' ? record.status : null;
  return id && status ? { id, status } : null;
}

export function readSupportConversationSummary(value: unknown): SupportConversationSummary | null {
  const ref = readSupportConversationRef(value);
  if (!ref) return null;
  const record = value as Record<string, unknown>;
  return {
    ...ref,
    userLastReadAt: readString(record.userLastReadAt),
    staffLastReadAt: readString(record.staffLastReadAt),
    userTyping: record.userTyping === true,
    staffTyping: record.staffTyping === true,
  };
}

function readMessages(value: unknown): SupportMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readSupportMessage)
    .filter((message): message is SupportMessage => message !== null);
}

/**
 * Reads `GET /api/support/conversation` (and the console's thread). Null for
 * an answer that is not one; a message the reader cannot read is left out
 * rather than failing the rest.
 */
export function readSupportConversationResponse(
  value: unknown,
): { conversation: SupportConversationSummary | null; messages: SupportMessage[] } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.messages)) return null;
  return {
    conversation: readSupportConversationSummary(record.conversation),
    messages: readMessages(record.messages),
  };
}

/** Reads `POST /api/support/conversation`'s answer. */
export function readSupportMessageResponse(
  value: unknown,
): { message: SupportMessage; conversation: SupportConversationRef } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const message = readSupportMessage(record.message);
  const conversation = readSupportConversationRef(record.conversation);
  return message && conversation ? { message, conversation } : null;
}

/** Reads the answer to an edit, a delete or a reaction. */
export function readSupportMessageUpdateResponse(value: unknown): { message: SupportMessage } | null {
  if (!value || typeof value !== 'object') return null;
  const message = readSupportMessage((value as Record<string, unknown>).message);
  return message ? { message } : null;
}

/** Reads `POST /api/support/conversation/read`'s answer. */
export function readSupportReadResponse(
  value: unknown,
): { userLastReadAt: string | null; staffLastReadAt: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.success !== true) return null;
  return {
    userLastReadAt: readString(record.userLastReadAt),
    staffLastReadAt: readString(record.staffLastReadAt),
  };
}
