'use client';

import clsx from 'clsx';
import {
  AlertCircle,
  ArrowDown,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  Copy,
  ImageOff,
  ImagePlus,
  Lock,
  Pencil,
  Reply,
  Send,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { pushToast } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';
import { thumbhashDataUrl } from '@/lib/thumbhash-data-url';
import { useTypedBeforeHydration } from '@/lib/use-typed-before-hydration';

import {
  SUPPORT_EMOJI_PANEL,
  SUPPORT_MESSAGE_COUNTER_FROM,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_PHOTO_TYPES,
  SUPPORT_REACTION_EMOJIS,
  SUPPORT_WORDS,
  canDeleteSupportMessage,
  canEditSupportMessage,
  canReactToSupportMessage,
  checkSupportMessage,
  createSupportClientMessageId,
  supportClockLabel,
  supportDeletedWords,
  supportMessageLength,
  supportOtherSideTyping,
  supportPhotoFrame,
  supportPhotoPickRefusal,
  supportQuoteAuthorName,
  supportQuoteOf,
  supportQuoteText,
  supportTextSegments,
  supportThreadRows,
  type SupportMessage,
  type SupportMessageAuthor,
  type SupportPendingMessage,
  type SupportPendingPhoto,
  type SupportPhoto,
  type SupportQuotedMessage,
  type SupportReactionEmoji,
  type SupportReceipt,
  type SupportThreadRow,
} from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

import type { SupportChatController, SupportChatPhoto } from './use-support-chat';

/**
 * A support thread drawn as a chat app draws one (owner, 2026-11-22: "make
 * the functionalities close to whatsapp as much as possible"): the other
 * side's name and "typing…" at the top; the thread in days, one side's
 * messages in a row grouped, a divider above the first one that was unread,
 * the time and the ticks inside each bubble; a reply quoting its message,
 * reactions under a bubble, and on hover (or a right click, or a long press on
 * a touch screen) React, Reply and a menu with Copy, Edit and Delete; a button
 * back to the latest message; and a composer that sends on Enter, with an
 * emoji panel and the message it replies to or edits above it. A photo is
 * attached with the picture button, pasted, or dropped on the thread, goes
 * with the text as its caption, and opens full screen when pressed.
 *
 * Shared by the account's `/support` page and the console's thread: `viewer`
 * says whose side this is.
 */

type FloatingAnchor = { top: number; bottom: number; left: number; right: number };

type FloatingPanel =
  // `openedAt`: the moment the menu opened, which decides whether Edit and Delete are still offered.
  | { kind: 'menu'; message: SupportMessage; anchor: FloatingAnchor; openedAt: number }
  | { kind: 'react'; message: SupportMessage; anchor: FloatingAnchor }
  | { kind: 'emoji'; anchor: FloatingAnchor };

const PANEL_GAP_PX = 8;
const AT_BOTTOM_PX = 96;

function anchorOf(element: Element): FloatingAnchor {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function anchorAtPoint(x: number, y: number): FloatingAnchor {
  return { top: y, bottom: y, left: x, right: x };
}

/** Where a panel of this size goes: below its anchor when it fits, else above, inside the window. */
function placePanel(anchor: FloatingAnchor, width: number, height: number, align: 'start' | 'end') {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = align === 'end' ? anchor.right - width : anchor.left;
  const left = Math.max(PANEL_GAP_PX, Math.min(preferredLeft, viewportWidth - width - PANEL_GAP_PX));
  const below = anchor.bottom + PANEL_GAP_PX;
  const top = below + height <= viewportHeight - PANEL_GAP_PX
    ? below
    : Math.max(PANEL_GAP_PX, anchor.top - PANEL_GAP_PX - height);
  return { top, left };
}

function ReceiptMark({ receipt }: { receipt: SupportReceipt | null }) {
  if (receipt === 'read') {
    return <CheckCheck className="h-3.5 w-3.5 text-[var(--ui-accent-image)]" aria-label="Read" />;
  }
  if (receipt === 'sent') {
    return <Check className="h-3.5 w-3.5" aria-label="Sent" />;
  }
  return null;
}

function MessageText({ text }: { text: string }) {
  return (
    <>
      {supportTextSegments(text).map((segment) => (segment.kind === 'link'
        ? (
          <a
            key={segment.start}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="break-all text-[var(--ui-accent-image)] underline underline-offset-2"
          >
            {segment.text}
          </a>
        )
        : <span key={segment.start}>{segment.text}</span>))}
    </>
  );
}

function QuoteBlock({
  quoted,
  viewer,
  otherName,
  onOpen,
}: {
  quoted: SupportQuotedMessage;
  viewer: SupportMessageAuthor;
  otherName: string;
  onOpen?: () => void;
}) {
  const content = (
    <>
      <span className="block truncate text-xs font-semibold text-[var(--ui-primary)]">
        {supportQuoteAuthorName(quoted.author, viewer, otherName)}
      </span>
      <span className={clsx('line-clamp-2 text-xs text-[var(--ui-text-secondary)]', quoted.deleted && 'italic')}>
        {supportQuoteText(quoted)}
      </span>
    </>
  );
  const className = clsx(
    'mb-1.5 block w-full rounded-lg border-l-2 border-[var(--ui-primary)] bg-[var(--ui-surface-inset)] px-2.5 py-1.5 text-left',
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className={clsx(className, 'ui-focus-ring hover:opacity-90')}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

/** The thread draws a photo at most this wide and tall; a taller one is cut, as a chat app cuts a long screenshot. */
const PHOTO_MAX_WIDTH = 288;
const PHOTO_MAX_HEIGHT = 360;
/** How long a photo that failed to load waits before it is tried once more by itself. */
const PHOTO_RETRY_MS = 2500;

/**
 * A photo in a bubble: the server's preview (the thumbhash under it while it
 * loads), or the picture on the device while it is on its way. A link that
 * no longer opens says so in the photo's place.
 */
function SupportPhotoView({
  photo,
  local,
  onOpen,
  children,
}: {
  photo: SupportPhoto | null;
  local: SupportPendingPhoto | null;
  onOpen?: () => void;
  /** Drawn over the photo's corner: the time and ticks of a photo without a caption. */
  children?: ReactNode;
}) {
  const source = photo ? photo.previewUrl : local?.localUri ?? null;
  const frame = supportPhotoFrame(
    { width: photo?.width ?? local?.width ?? 4, height: photo?.height ?? local?.height ?? 3 },
    { maxWidth: PHOTO_MAX_WIDTH, maxHeight: PHOTO_MAX_HEIGHT },
  );
  const placeholder = photo ? thumbhashDataUrl(photo.thumbhash) : null;
  return (
    <SupportPhotoFrame
      // A new link is a new picture to load, and a new chance after a failure.
      key={source ?? 'none'}
      source={source}
      placeholder={placeholder}
      width={frame.width}
      height={frame.height}
      onOpen={onOpen}
    >
      {children}
    </SupportPhotoFrame>
  );
}

function SupportPhotoFrame({
  source,
  placeholder,
  width,
  height,
  onOpen,
  children,
}: {
  source: string | null;
  placeholder: string | null;
  width: number;
  height: number;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  // Each try is a new <img>: a link that failed once (a dropped connection)
  // is tried again by itself a moment later, then on a press.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed || attempt > 0) return undefined;
    const timer = window.setTimeout(() => {
      setFailed(false);
      setAttempt(1);
    }, PHOTO_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, failed]);
  const broken = failed || !source;
  const className = 'relative block overflow-hidden rounded-xl bg-[var(--ui-surface-3)]';

  if (failed && source && attempt > 0) {
    return (
      <button
        type="button"
        onClick={() => {
          setFailed(false);
          setAttempt((current) => current + 1);
        }}
        className={clsx(className, 'ui-focus-ring')}
        style={{ width, height }}
      >
        <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center text-xs text-[var(--ui-text-faint)]">
          <ImageOff className="h-5 w-5" aria-hidden />
          {SUPPORT_WORDS.photoLoadFailed}
          <span className="font-semibold text-[var(--ui-text-secondary)]">{SUPPORT_WORDS.photoTryAgain}</span>
        </span>
        {children}
      </button>
    );
  }

  const picture = broken ? (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-3 text-center text-xs text-[var(--ui-text-faint)]">
      <ImageOff className="h-5 w-5" aria-hidden />
      {SUPPORT_WORDS.photoLoadFailed}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- a signed link of a private bucket, already sized by the server
    <img
      key={attempt}
      src={source}
      alt={SUPPORT_WORDS.photo}
      width={width}
      height={height}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
      style={placeholder ? { backgroundImage: `url(${placeholder})`, backgroundSize: 'cover' } : undefined}
    />
  );
  return onOpen && !broken ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={SUPPORT_WORDS.openPhoto}
      className={clsx(className, 'ui-focus-ring')}
      style={{ width, height }}
    >
      {picture}
      {children}
    </button>
  ) : (
    <span className={className} style={{ width, height }}>
      {picture}
      {children}
    </span>
  );
}

/** A photo full screen, in the browser's own modal dialog: Escape, the close button or a press beside the picture closes it. */
function SupportPhotoLightbox({ photo, onClose }: { photo: SupportPhoto; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }, []);

  if (typeof document === 'undefined') return null;
  const source = photo.url ?? photo.previewUrl;
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={SUPPORT_WORDS.photo}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[70] m-0 flex h-full max-h-none w-full max-w-none items-center justify-center bg-[var(--ui-media-backdrop)] p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={SUPPORT_WORDS.closePhoto}
        title={SUPPORT_WORDS.closePhoto}
        autoFocus
        className="ui-icon-button ui-focus-ring absolute right-4 top-4 h-11 w-11 bg-[var(--ui-surface-raised)]"
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed link of a private bucket
        <img
          src={source}
          alt={SUPPORT_WORDS.photo}
          className="max-h-full max-w-full object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </dialog>,
    document.body,
  );
}

type BubbleProps = {
  row: Extract<SupportThreadRow, { kind: 'message' | 'pending' }>;
  viewer: SupportMessageAuthor;
  otherName: string;
  flashing: boolean;
  onOpenQuote: (id: string) => void;
  onOpenPanel: (panel: FloatingPanel) => void;
  onReply: (message: SupportMessage) => void;
  onReact: (message: SupportMessage, emoji: SupportReactionEmoji) => void;
  onRetry: (pending: SupportPendingMessage) => void;
  onDiscard: (pending: SupportPendingMessage) => void;
  onOpenPhoto: (photo: SupportPhoto) => void;
};

/** A bubble's corner: "Edited", the time, and the ticks, the clock while sending, or the not-sent mark. */
function BubbleMeta({
  message,
  pending,
  failed,
  time,
  row,
  deleted,
}: {
  message: SupportMessage | null;
  pending: SupportPendingMessage | null;
  failed: boolean;
  time: string;
  row: BubbleProps['row'];
  deleted: boolean;
}) {
  return (
    <>
      {message?.editedAt && !deleted ? <span>{SUPPORT_WORDS.edited}</span> : null}
      <time dateTime={message?.createdAt ?? pending?.createdAt}>{time}</time>
      {pending ? (
        failed
          ? <AlertCircle className="h-3.5 w-3.5 text-[var(--ui-accent-danger)]" aria-label="Not sent" />
          : <Clock3 className="h-3.5 w-3.5" aria-label={SUPPORT_WORDS.sending} />
      ) : row.kind === 'message' ? <ReceiptMark receipt={row.receipt} /> : null}
    </>
  );
}

function SupportBubble({
  row,
  viewer,
  otherName,
  flashing,
  onOpenQuote,
  onOpenPanel,
  onReply,
  onReact,
  onRetry,
  onDiscard,
  onOpenPhoto,
}: BubbleProps) {
  const mine = row.kind === 'pending' || row.mine;
  const message = row.kind === 'message' ? row.message : null;
  const pending = row.kind === 'pending' ? row.pending : null;
  const deleted = Boolean(message?.deletedAt);
  const failed = pending?.state === 'failed';
  const quoted = message?.replyTo ?? pending?.replyTo ?? null;
  const body = message ? message.body : pending?.body ?? '';
  const time = supportClockLabel(message?.createdAt ?? pending?.createdAt ?? '');
  const actionable = Boolean(message) && !deleted;
  const photo = deleted ? null : message?.attachment ?? null;
  const localPhoto = pending?.photo ?? null;
  const hasPhoto = Boolean(photo || localPhoto);
  const caption = body ?? '';

  const openMenuAt = (anchor: FloatingAnchor) => {
    if (message && actionable) onOpenPanel({ kind: 'menu', message, anchor, openedAt: Date.now() });
  };

  // Shown on hover or focus; always on a screen without hover, where a long
  // press may not reach the menu. On the bubble's inner side.
  const tools = message && actionable ? (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        aria-label={SUPPORT_WORDS.react}
        title={SUPPORT_WORDS.react}
        onClick={(event) => onOpenPanel({ kind: 'react', message, anchor: anchorOf(event.currentTarget) })}
        className="ui-icon-button ui-focus-ring h-8 w-8"
      >
        <Smile className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={SUPPORT_WORDS.reply}
        title={SUPPORT_WORDS.reply}
        onClick={() => onReply(message)}
        className="ui-icon-button ui-focus-ring h-8 w-8"
      >
        <Reply className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={SUPPORT_WORDS.moreActions}
        title={SUPPORT_WORDS.moreActions}
        aria-haspopup="menu"
        onClick={(event) => openMenuAt(anchorOf(event.currentTarget))}
        className="ui-icon-button ui-focus-ring h-8 w-8"
      >
        <ChevronDown className="h-4 w-4" aria-hidden />
      </button>
    </div>
  ) : null;

  return (
    <li
      id={message ? `support-message-${message.id}` : undefined}
      className={clsx(
        'group relative flex w-full',
        mine && 'justify-end',
        row.startsGroup ? 'mt-3' : 'mt-1',
        message && message.reactions.length > 0 && 'mb-4',
      )}
    >
      <div className="relative flex max-w-[80%] items-center gap-1.5">
        {mine ? tools : null}
        <div
          onContextMenu={(event: ReactMouseEvent) => {
            if (!actionable) return;
            event.preventDefault();
            openMenuAt(anchorAtPoint(event.clientX, event.clientY));
          }}
          className={clsx(
            'relative min-w-0 rounded-2xl text-sm leading-6 text-[var(--ui-text-primary)]',
            hasPhoto ? 'p-1' : 'px-3 pb-1 pt-2',
            mine
              ? 'bg-[var(--ui-primary-soft)]'
              : 'border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)]',
            row.startsGroup && (mine ? 'rounded-tr-lg' : 'rounded-tl-lg'),
            pending && !failed && 'opacity-80',
            flashing && 'ring-2 ring-[var(--ui-primary)]',
          )}
        >
          {quoted && !deleted ? (
            <QuoteBlock
              quoted={quoted}
              viewer={viewer}
              otherName={otherName}
              onOpen={quoted.deleted ? undefined : () => onOpenQuote(quoted.id)}
            />
          ) : null}
          {hasPhoto ? (
            <SupportPhotoView
              photo={photo}
              local={localPhoto}
              onOpen={photo ? () => onOpenPhoto(photo) : undefined}
            >
              {caption ? null : (
                // Over a photo without a caption, the time stands on a dark pill in its corner.
                <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-full bg-[var(--ui-media-scrim)] px-1.5 py-0.5 text-xs leading-none text-[var(--ui-text-primary)]">
                  <BubbleMeta message={message} pending={pending} failed={failed} time={time} row={row} deleted={deleted} />
                </span>
              )}
            </SupportPhotoView>
          ) : null}
          {deleted && message ? (
            <span className="inline-flex items-center gap-1.5 italic text-[var(--ui-text-faint)]">
              <Ban className="h-3.5 w-3.5" aria-hidden />
              {supportDeletedWords(message, viewer)}
            </span>
          ) : caption ? (
            <span className={clsx('whitespace-pre-wrap break-words', hasPhoto && 'block px-2 pt-1')}>
              <MessageText text={caption} />
            </span>
          ) : null}
          {!hasPhoto || caption || deleted ? (
            <span className={clsx(
              'float-right ml-2 mt-2 inline-flex translate-y-1 items-center gap-1 text-xs leading-none text-[var(--ui-text-faint)]',
              hasPhoto && 'mb-1.5 mr-2',
            )}
            >
              <BubbleMeta message={message} pending={pending} failed={failed} time={time} row={row} deleted={deleted} />
            </span>
          ) : null}

          {message && message.reactions.length > 0 ? (
            <span className={clsx('absolute -bottom-4 flex gap-0.5', mine ? 'right-2' : 'left-2')}>
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.author}
                  type="button"
                  onClick={() => onReact(message, reaction.emoji)}
                  disabled={reaction.author !== viewer}
                  title={reaction.author === viewer ? 'Remove your reaction' : `${supportQuoteAuthorName(reaction.author, viewer, otherName)} reacted`}
                  aria-label={reaction.author === viewer
                    ? `Your reaction ${reaction.emoji}. Remove it`
                    : `${supportQuoteAuthorName(reaction.author, viewer, otherName)} reacted ${reaction.emoji}`}
                  className="ui-focus-ring flex h-6 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-3)] px-1.5 text-sm leading-none"
                >
                  {reaction.emoji}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {mine ? null : tools}
      </div>

      {failed && pending ? (
        <span className="absolute right-1 top-full mt-0.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => onRetry(pending)}
            className="ui-focus-ring rounded-lg text-xs font-semibold text-[var(--ui-accent-danger)] underline underline-offset-2"
          >
            {SUPPORT_WORDS.notSent}
          </button>
          <button
            type="button"
            onClick={() => onDiscard(pending)}
            aria-label={`${SUPPORT_WORDS.delete}: ${SUPPORT_WORDS.notSentActions}`}
            className="ui-focus-ring rounded-lg text-xs font-semibold text-[var(--ui-text-secondary)] underline underline-offset-2"
          >
            {SUPPORT_WORDS.delete}
          </button>
        </span>
      ) : null}
    </li>
  );
}

/**
 * The floating panels of a thread, one at a time: a message's menu, its
 * reactions, or the composer's emoji. Drawn at the body, placed from what
 * opened them, and closed by Escape, a press outside, or the window resizing.
 */
function SupportChatFloatingPanel({
  panel,
  viewer,
  onClose,
  onShowReactions,
  onInsertEmoji,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onDelete,
}: {
  panel: FloatingPanel;
  viewer: SupportMessageAuthor;
  onClose: () => void;
  onShowReactions: (message: SupportMessage, anchor: FloatingAnchor) => void;
  onInsertEmoji: (emoji: string) => void;
  onReact: (message: SupportMessage, emoji: SupportReactionEmoji) => void;
  onReply: (message: SupportMessage) => void;
  onCopy: (message: SupportMessage) => void;
  onEdit: (message: SupportMessage) => void;
  onDelete: (message: SupportMessage) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && panelRef.current?.contains(target)) return;
      // The emoji button toggles its own panel.
      if (panel.kind === 'emoji' && target?.closest?.('[data-support-emoji-trigger]')) return;
      onClose();
    };
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, panel.kind]);

  if (typeof document === 'undefined') return null;

  if (panel.kind === 'emoji') {
    // Six to a row: 36 px buttons, their gaps and the panel's padding.
    const width = 6 * 36 + 5 * 2 + 2 * 8;
    const position = placePanel(panel.anchor, width, 10 * 38 + 16, 'start');
    return createPortal(
      <div
        ref={panelRef}
        role="dialog"
        aria-label={SUPPORT_WORDS.emoji}
        style={{ position: 'fixed', top: position.top, left: position.left, width }}
        className="z-[70] rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] p-2 shadow-[var(--ui-shadow-panel)]"
      >
        <div className="flex flex-wrap gap-0.5">
          {SUPPORT_EMOJI_PANEL.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onInsertEmoji(emoji)}
              className="ui-focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-xl hover:bg-[var(--ui-surface-3)]"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>,
      document.body,
    );
  }

  const { message } = panel;
  const mine = message.reactions.find((reaction) => reaction.author === viewer)?.emoji ?? null;
  const align = viewer === message.author ? 'end' : 'start';

  if (panel.kind === 'react') {
    const width = 6 * 44 + 16;
    const position = placePanel(panel.anchor, width, 56, align);
    return createPortal(
      <div
        ref={panelRef}
        role="menu"
        aria-label={SUPPORT_WORDS.react}
        style={{ position: 'fixed', top: position.top, left: position.left, width }}
        className="z-[70] flex items-center gap-0.5 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] p-2 shadow-[var(--ui-shadow-panel)]"
      >
        {SUPPORT_REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="menuitemradio"
            aria-checked={mine === emoji}
            aria-label={`React ${emoji}`}
            onClick={() => onReact(message, emoji)}
            className={clsx(
              'ui-focus-ring flex h-10 w-10 items-center justify-center rounded-full text-2xl transition-transform hover:scale-110',
              mine === emoji && 'bg-[var(--ui-primary-soft)]',
            )}
          >
            {emoji}
          </button>
        ))}
      </div>,
      document.body,
    );
  }

  const now = panel.openedAt;
  const items: Array<{ label: string; icon: typeof Reply; onSelect: () => void; danger?: boolean }> = [
    { label: SUPPORT_WORDS.reply, icon: Reply, onSelect: () => onReply(message) },
    ...(canReactToSupportMessage(message)
      ? [{ label: SUPPORT_WORDS.react, icon: Smile, onSelect: () => onShowReactions(message, panel.anchor) }]
      : []),
    ...(message.body ? [{ label: SUPPORT_WORDS.copy, icon: Copy, onSelect: () => onCopy(message) }] : []),
    ...(canEditSupportMessage(message, viewer, now)
      ? [{ label: SUPPORT_WORDS.edit, icon: Pencil, onSelect: () => onEdit(message) }]
      : []),
    ...(canDeleteSupportMessage(message, viewer, now)
      ? [{ label: SUPPORT_WORDS.delete, icon: Trash2, onSelect: () => onDelete(message), danger: true }]
      : []),
  ];
  const width = 208;
  const position = placePanel(panel.anchor, width, items.length * 44 + 12, align);
  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={SUPPORT_WORDS.moreActions}
      style={{ position: 'fixed', top: position.top, left: position.left, width }}
      className="z-[70] rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] p-1.5 shadow-[var(--ui-shadow-panel)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onSelect}
          className={clsx(
            'ui-focus-ring flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-[var(--ui-surface-3)]',
            item.danger ? 'text-[var(--ui-accent-danger)]' : 'text-[var(--ui-text-primary)]',
          )}
        >
          <item.icon className="h-4 w-4 shrink-0" aria-hidden />
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function SupportChat({
  chat,
  viewer,
  title,
  avatar,
  statusLine,
  otherName,
  headerActions,
  privacyNote = null,
  emptyTitle,
  emptyBody,
  closedNote = null,
  composerRequest = null,
  className,
}: {
  chat: SupportChatController;
  viewer: SupportMessageAuthor;
  title: string;
  avatar: ReactNode;
  statusLine: string;
  /** The other side's name, for quotes and reactions: "Magicbooklet support", or the account's name. */
  otherName: string;
  headerActions?: ReactNode;
  privacyNote?: string | null;
  emptyTitle: string;
  emptyBody: string;
  /** Drawn under the thread while the conversation is resolved. */
  closedNote?: string | null;
  /**
   * Opens the composer to be written in while the chat stays mounted: each new
   * `nonce` puts `text` in an empty composer (a message already started, or an
   * edit, is kept) and the focus after it. Help & Support's "Suggest a feature".
   */
  composerRequest?: { text: string; nonce: number } | null;
  className?: string;
}) {
  const { state, pending, error, unreadMark } = chat;
  const confirm = useConfirmation();
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<SupportQuotedMessage | null>(null);
  const [editing, setEditing] = useState<SupportMessage | null>(null);
  // An edit on its way to the server: the composer keeps its text until the answer.
  const [savingEdit, setSavingEdit] = useState(false);
  // What the composer held when an edit began, given back when the edit ends.
  const draftBeforeEditRef = useRef('');
  const [panel, setPanel] = useState<FloatingPanel | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  // The photo about to go with the next message, and the one open full screen.
  const [photoDraft, setPhotoDraft] = useState<SupportChatPhoto | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState<SupportPhoto | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The draft's object URL, released when the page goes.
  const draftUrlRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const placedRef = useRef(false);
  const seenRef = useRef<{ total: number; others: number }>({ total: 0, others: 0 });
  // Typing that reached the field before the page's script ran.
  useTypedBeforeHydration(fieldRef, { drawn: '', enabled: true, onTyped: setDraft });

  useEffect(() => () => {
    if (draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
  }, []);

  // A request to write ("Suggest a feature"), taken as it is drawn, once per nonce: its text goes
  // into an empty composer only (a message already started, or an edit, is kept), then the focus
  // follows it once that text is drawn.
  const [takenRequest, setTakenRequest] = useState<number | null>(null);
  const [focusRequested, setFocusRequested] = useState(0);
  if (composerRequest && composerRequest.nonce !== takenRequest) {
    setTakenRequest(composerRequest.nonce);
    if (!editing && !draft.trim()) setDraft(composerRequest.text);
    setFocusRequested((count) => count + 1);
  }
  useEffect(() => {
    if (focusRequested === 0) return;
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focusRequested]);

  const ready = state.kind === 'ready';
  const messages = useMemo(() => (state.kind === 'ready' ? state.messages : []), [state]);
  const conversation = state.kind === 'ready' ? state.conversation : null;
  const typing = supportOtherSideTyping(conversation, viewer);

  const rows = useMemo(() => supportThreadRows({
    messages,
    pending,
    conversation,
    viewer,
    unreadFromId: unreadMark?.fromId ?? null,
    unreadCount: unreadMark?.count ?? 0,
  }), [conversation, messages, pending, unreadMark, viewer]);

  const totalCount = messages.length + pending.length;
  const othersCount = useMemo(() => messages.filter((message) => message.author !== viewer).length, [messages, viewer]);
  const lastMine = rows.length > 0 && (() => {
    const last = rows[rows.length - 1];
    return last.kind === 'pending' || (last.kind === 'message' && last.mine);
  })();

  // The thread opens at the first unread message, else at the end; after
  // that a new message follows the end only while the reader is there (or
  // wrote it), and otherwise counts on the button back to it.
  useEffect(() => {
    if (!ready) return undefined;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      if (!placedRef.current) {
        placedRef.current = true;
        seenRef.current = { total: totalCount, others: othersCount };
        const divider = element.querySelector('[data-support-unread]');
        if (divider instanceof HTMLElement) {
          element.scrollTop = Math.max(0, divider.offsetTop - 24);
        } else {
          element.scrollTop = element.scrollHeight;
        }
        return;
      }
      const seen = seenRef.current;
      seenRef.current = { total: totalCount, others: othersCount };
      if (totalCount <= seen.total) return;
      if (atBottomRef.current || lastMine) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
      } else if (othersCount > seen.others) {
        setNewCount((count) => count + (othersCount - seen.others));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [lastMine, othersCount, ready, totalCount]);

  // A reply arriving under an open "typing…" while the reader is at the end keeps them there.
  useEffect(() => {
    if (!typing || !atBottomRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [typing]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < AT_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
    if (atBottom) setNewCount(0);
    if (panel && panel.kind !== 'emoji') setPanel(null);
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setNewCount(0);
  };

  // The composer grows with its text, to six lines.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 168)}px`;
  }, [draft]);

  // At once, in the press: a frame callback never runs in a tab the browser
  // has put in the background, and typing that starts right after the press
  // would go nowhere.
  const focusField = () => fieldRef.current?.focus();

  /** Leaves an edit: the composer gets back what it held before the edit began. */
  const endEdit = () => {
    setEditing(null);
    setDraft(draftBeforeEditRef.current);
    draftBeforeEditRef.current = '';
  };

  const startReply = (message: SupportMessage) => {
    if (savingEdit) return;
    setPanel(null);
    if (editing) endEdit();
    setReplyTo(supportQuoteOf(message));
    focusField();
  };

  const startEdit = (message: SupportMessage) => {
    if (savingEdit) return;
    setPanel(null);
    setReplyTo(null);
    // The unsent draft waits aside while the edit is written.
    if (!editing) draftBeforeEditRef.current = draft;
    setEditing(message);
    setDraft(message.body ?? '');
    focusField();
  };

  const cancelCompose = () => {
    if (savingEdit) return;
    if (editing) endEdit();
    setReplyTo(null);
  };

  const dropPhotoDraft = (release: boolean) => {
    if (release && draftUrlRef.current) URL.revokeObjectURL(draftUrlRef.current);
    draftUrlRef.current = null;
    setPhotoDraft(null);
  };

  /** A photo picked, pasted or dropped: held to the rule, then drawn above the composer until it goes. */
  const pickPhoto = (file: File) => {
    if (editing) return;
    const refusal = supportPhotoPickRefusal({ type: file.type, size: file.size });
    if (refusal) {
      chat.setError(refusal);
      return;
    }
    chat.setError(null);
    dropPhotoDraft(true);
    const localUri = URL.createObjectURL(file);
    draftUrlRef.current = localUri;
    setPhotoDraft({ file, preview: { localUri, width: null, height: null } });
    // Its size, once the browser has read it, so the bubble is drawn in its shape.
    const image = new Image();
    image.onload = () => setPhotoDraft((current) => (current?.preview.localUri === localUri
      ? { ...current, preview: { ...current.preview, width: image.naturalWidth, height: image.naturalHeight } }
      : current));
    image.src = localUri;
    focusField();
  };

  const pickedImage = (files: FileList | null | undefined) => (
    Array.from(files ?? []).find((file) => file.type.startsWith('image/')) ?? null
  );

  const openQuote = useCallback((id: string) => {
    const target = document.getElementById(`support-message-${id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1400);
  }, []);

  const copyMessage = async (message: SupportMessage) => {
    setPanel(null);
    if (!message.body) return;
    try {
      await navigator.clipboard.writeText(message.body);
      pushToast({ tone: 'success', message: SUPPORT_WORDS.copied, durationMs: 1800 });
    } catch {
      pushToast({ tone: 'error', message: SUPPORT_WORDS.actionFailed });
    }
  };

  const deleteMessage = async (message: SupportMessage) => {
    setPanel(null);
    const confirmed = await confirm({
      title: SUPPORT_WORDS.deleteTitle,
      message: SUPPORT_WORDS.deleteBody,
      confirmLabel: SUPPORT_WORDS.deleteConfirm,
      tone: 'danger',
    });
    if (!confirmed) return;
    if (editing?.id === message.id) cancelCompose();
    await chat.remove(message);
  };

  const react = useCallback((message: SupportMessage, emoji: SupportReactionEmoji) => {
    setPanel(null);
    void chat.react(message, emoji);
  }, [chat]);

  const retry = useCallback((item: SupportPendingMessage) => {
    void chat.send(item.body, item.clientMessageId, item.replyTo);
  }, [chat]);

  const discard = useCallback((item: SupportPendingMessage) => {
    chat.discard(item.clientMessageId);
  }, [chat]);

  const checked = checkSupportMessage(draft, { hasPhoto: photoDraft !== null && !editing });
  const length = supportMessageLength(draft);
  const canSend = ready && checked.ok && !savingEdit;

  /** Saves an edit, keeping its text in the composer until the server has it: a refusal leaves it there to send again. */
  const saveEdit = async (target: SupportMessage, body: string) => {
    if (target.body === body) {
      endEdit();
      return;
    }
    setSavingEdit(true);
    const saved = await chat.edit(target, body);
    setSavingEdit(false);
    if (saved) endEdit();
  };

  const handleSubmit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend || !checked.ok) return;
    if (editing) {
      void saveEdit(editing, checked.body);
      return;
    }
    const quoted = replyTo;
    const photo = photoDraft;
    setReplyTo(null);
    setDraft('');
    // The object URL now belongs to the message on its way (the chat releases it once kept).
    dropPhotoDraft(false);
    void chat.send(checked.body, createSupportClientMessageId(), quoted, photo);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, as in a chat app; Shift with Enter starts a new line. The
    // Enter that ends an input method's word is not a send: Safari no longer
    // says it composes then, but keeps keyCode 229.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      handleSubmit();
      return;
    }
    if (event.key === 'Escape' && (replyTo || editing)) {
      event.preventDefault();
      cancelCompose();
      return;
    }
    if (event.key === 'Escape' && photoDraft) {
      event.preventDefault();
      dropPhotoDraft(true);
    }
  };

  const insertEmoji = (emoji: string) => {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
    chat.noteTyping();
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      const caret = start + emoji.length;
      field.setSelectionRange(caret, caret);
    });
  };

  const composeTarget = editing
    ? { title: SUPPORT_WORDS.editing, text: supportQuoteText(supportQuoteOf(editing)), cancel: SUPPORT_WORDS.cancelEdit }
    : replyTo
      ? {
        title: supportQuoteAuthorName(replyTo.author, viewer, otherName),
        text: supportQuoteText(replyTo),
        cancel: SUPPORT_WORDS.cancelReply,
      }
      : null;

  return (
    <section
      // A file dropped anywhere on the chat is the chat's: never opened in the
      // tab, which would leave the page and its draft.
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        if (editing || !ready) return;
        const file = pickedImage(event.dataTransfer.files);
        if (file) {
          pickPhoto(file);
          return;
        }
        const dropped = event.dataTransfer.files[0];
        chat.setError(supportPhotoPickRefusal({ type: dropped?.type ?? '', size: dropped?.size ?? 0 }));
      }}
      className={clsx(
        'flex h-[min(760px,calc(100dvh-200px))] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] shadow-[var(--ui-shadow-panel)]',
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-4 py-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{title}</p>
          <p
            aria-live="polite"
            className={clsx('truncate text-xs', typing ? 'font-medium text-[var(--ui-primary)]' : 'text-[var(--ui-text-faint)]')}
          >
            {typing ? SUPPORT_WORDS.typing : statusLine}
          </p>
        </div>
        {headerActions}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          className="h-full overflow-y-auto px-3 pb-6 pt-4 sm:px-6"
        >
          {privacyNote ? (
            <p className="mx-auto mb-3 flex w-fit max-w-md items-center gap-1.5 rounded-lg bg-[var(--ui-surface-2)] px-3 py-1.5 text-center text-xs text-[var(--ui-text-muted)]">
              <Lock className="h-3 w-3 shrink-0" aria-hidden />
              {privacyNote}
            </p>
          ) : null}

          {state.kind === 'loading' ? (
            <p className="py-10 text-center text-sm text-[var(--ui-text-faint)]">Loading messages…</p>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center">
              <h2 className="text-base font-semibold text-[var(--ui-text-primary)]">{emptyTitle}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--ui-text-secondary)]">{emptyBody}</p>
            </div>
          ) : (
            <ol className="flex flex-col">
              {rows.map((row) => {
                if (row.kind === 'day') {
                  return (
                    <li key={row.key} className="my-3 flex justify-center">
                      <span className="rounded-lg bg-[var(--ui-surface-2)] px-3 py-1 text-xs font-medium text-[var(--ui-text-secondary)]">
                        {row.label}
                      </span>
                    </li>
                  );
                }
                if (row.kind === 'unread') {
                  return (
                    <li key={row.key} data-support-unread className="my-3 flex justify-center bg-[var(--ui-surface-2)] py-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--ui-text-secondary)]">
                        {row.label}
                      </span>
                    </li>
                  );
                }
                return (
                  <SupportBubble
                    key={row.key}
                    row={row}
                    viewer={viewer}
                    otherName={otherName}
                    flashing={row.kind === 'message' && flashId === row.message.id}
                    onOpenQuote={openQuote}
                    onOpenPanel={setPanel}
                    onReply={startReply}
                    onReact={react}
                    onRetry={retry}
                    onDiscard={discard}
                    onOpenPhoto={setViewingPhoto}
                  />
                );
              })}
            </ol>
          )}

          {closedNote && conversation?.status === 'resolved' ? (
            <p className="mt-6 text-center text-xs text-[var(--ui-text-faint)]">{closedNote}</p>
          ) : null}
        </div>

        {showJump ? (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label={SUPPORT_WORDS.jumpToLatest}
            title={SUPPORT_WORDS.jumpToLatest}
            className="ui-focus-ring absolute bottom-4 right-4 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] text-[var(--ui-text-primary)] shadow-[var(--ui-shadow-panel)]"
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
            {newCount > 0 ? (
              <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ui-primary)] px-1 text-xs font-semibold text-[var(--ui-primary-on)]">
                {newCount}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-3 py-3 sm:px-5">
        {composeTarget ? (
          <div className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-[var(--ui-primary)] bg-[var(--ui-surface-inset)] px-3 py-2">
            {editing ? <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ui-primary)]" aria-hidden /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-[var(--ui-primary)]">{composeTarget.title}</p>
              <p className="line-clamp-2 text-xs text-[var(--ui-text-secondary)]">{composeTarget.text}</p>
            </div>
            <button
              type="button"
              onClick={cancelCompose}
              aria-label={composeTarget.cancel}
              title={composeTarget.cancel}
              className="ui-icon-button ui-focus-ring h-7 w-7 shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}

        {photoDraft && !editing ? (
          <div className="mb-2 flex items-center gap-3 rounded-xl border-l-2 border-[var(--ui-primary)] bg-[var(--ui-surface-inset)] px-3 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- the picked file on this device */}
            <img
              src={photoDraft.preview.localUri}
              alt=""
              className="h-11 w-11 shrink-0 rounded-lg object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-[var(--ui-primary)]">{SUPPORT_WORDS.photo}</p>
              <p className="truncate text-xs text-[var(--ui-text-secondary)]">{photoDraft.file.name || SUPPORT_WORDS.photo}</p>
            </div>
            <button
              type="button"
              onClick={() => dropPhotoDraft(true)}
              aria-label={SUPPORT_WORDS.removePhoto}
              title={SUPPORT_WORDS.removePhoto}
              className="ui-icon-button ui-focus-ring h-7 w-7 shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <button
            type="button"
            data-support-emoji-trigger
            aria-label={SUPPORT_WORDS.emoji}
            title={SUPPORT_WORDS.emoji}
            aria-expanded={panel?.kind === 'emoji'}
            onClick={(event) => setPanel((current) => (current?.kind === 'emoji'
              ? null
              : { kind: 'emoji', anchor: anchorOf(event.currentTarget) }))}
            className="ui-icon-button ui-focus-ring h-11 w-11 shrink-0"
          >
            <Smile className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={SUPPORT_WORDS.attachPhoto}
            title={SUPPORT_WORDS.attachPhoto}
            disabled={Boolean(editing) || !ready}
            onClick={() => fileRef.current?.click()}
            className="ui-icon-button ui-focus-ring h-11 w-11 shrink-0 disabled:opacity-40"
          >
            <ImagePlus className="h-5 w-5" aria-hidden />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={SUPPORT_PHOTO_TYPES.join(',')}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so the same file picked again is a change.
              event.target.value = '';
              if (file) pickPhoto(file);
            }}
          />
          <label htmlFor={`support-composer-${viewer}`} className="sr-only">{SUPPORT_WORDS.placeholder}</label>
          <textarea
            id={`support-composer-${viewer}`}
            ref={fieldRef}
            value={draft}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              chat.noteTyping();
            }}
            onKeyDown={handleKeyDown}
            onPaste={(event) => {
              // A screenshot pasted into the field goes as the photo, as does
              // a picture copied from a page or an app with its address or
              // name beside it. Cells copied from a spreadsheet carry a
              // picture of themselves beside their text, and paste as the
              // text: told by the cells' tabs, or the table they come in.
              const text = event.clipboardData?.getData('text/plain') ?? '';
              const html = event.clipboardData?.getData('text/html') ?? '';
              if (text.trim() && (text.includes('\t') || /<table[\s>]/i.test(html))) return;
              const file = pickedImage(event.clipboardData?.files);
              if (!file || editing) return;
              event.preventDefault();
              pickPhoto(file);
            }}
            placeholder={photoDraft && !editing ? SUPPORT_WORDS.addCaption : SUPPORT_WORDS.placeholder}
            className="ui-focus-ring min-h-11 flex-1 resize-none rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-2.5 text-sm leading-6 text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={editing ? SUPPORT_WORDS.save : SUPPORT_WORDS.send}
            title={editing ? SUPPORT_WORDS.save : SUPPORT_WORDS.send}
            className="ui-focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--ui-primary)] text-[var(--ui-primary-on)] transition-opacity disabled:opacity-40"
          >
            {editing ? <Check className="h-5 w-5" aria-hidden /> : <Send className="h-[18px] w-[18px]" aria-hidden />}
          </button>
        </div>

        {length >= SUPPORT_MESSAGE_COUNTER_FROM ? (
          <p className={clsx('mt-1.5 text-right text-xs', length > SUPPORT_MESSAGE_MAX_LENGTH ? 'text-[var(--ui-accent-danger)]' : 'text-[var(--ui-text-faint)]')}>
            {`${length.toLocaleString()} / ${SUPPORT_MESSAGE_MAX_LENGTH.toLocaleString()}`}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-xs font-semibold text-[var(--ui-accent-danger)]">{error}</p>
        ) : null}
      </form>

      {panel ? (
        <SupportChatFloatingPanel
          panel={panel}
          viewer={viewer}
          onClose={() => setPanel(null)}
          onShowReactions={(message, anchor) => setPanel({ kind: 'react', message, anchor })}
          onInsertEmoji={insertEmoji}
          onReact={react}
          onReply={startReply}
          onCopy={(message) => void copyMessage(message)}
          onEdit={startEdit}
          onDelete={(message) => void deleteMessage(message)}
        />
      ) : null}

      {viewingPhoto ? <SupportPhotoLightbox photo={viewingPhoto} onClose={() => setViewingPhoto(null)} /> : null}
    </section>
  );
}
