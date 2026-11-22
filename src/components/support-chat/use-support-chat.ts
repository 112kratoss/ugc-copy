'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  SUPPORT_POLL_ACTIVE_MS,
  SUPPORT_WORDS,
  failPendingSupportMessage,
  settlePendingSupportMessage,
  startPendingSupportMessage,
  supportDeletedMessage,
  supportEditedMessage,
  supportPollDelay,
  supportReactionToggle,
  supportShouldPingTyping,
  supportThreadSignature,
  supportUnreadMessages,
  withoutKeptPendingMessages,
  withStableSupportPhotoLinks,
  withSupportConversationRef,
  withSupportMessage,
  withSupportReadTimes,
  type SupportConversationRef,
  type SupportConversationSummary,
  type SupportMessage,
  type SupportMessageAuthor,
  type SupportPendingMessage,
  type SupportPendingPhoto,
  type SupportQuotedMessage,
  type SupportReactionEmoji,
} from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * One support thread, open in a browser: the account's `/support` page or the
 * console's thread. It reads the thread again every few seconds while the tab
 * is visible (often while things move, less once quiet), keeps the viewer's
 * messages that are on their way, says "typing" while the viewer writes, marks
 * the thread read while it is on screen, and draws every change at once,
 * putting it back if the server refuses. A photo is drawn from the device
 * while it goes, and kept for a retry. Each side brings its transport: the
 * account's routes, or the console's.
 *
 * A read that left before a change this side drew (a send kept, an edit, a
 * delete, a reaction, a status switch) is older than what is on screen: its
 * answer is dropped and the thread read again. Sends go one at a time, in the
 * order they were written, so a photo and the words after it are kept in that
 * order. A message a read shows was kept under its client id settles the copy
 * drawn as on its way, though the send's own answer was lost.
 */

/** A photo the viewer picked: the file, and what the thread draws until the server's copy comes. */
export type SupportChatPhoto = { file: File; preview: SupportPendingPhoto };

export type SupportChatLoadResult =
  | { kind: 'ok'; conversation: SupportConversationSummary | null; messages: SupportMessage[] }
  | { kind: 'signed-out' }
  | { kind: 'registration-required' }
  | { kind: 'not-found' }
  | { kind: 'failed' };

export type SupportChatActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string | null; signedOut?: boolean; code?: string | null };

export type SupportChatTransport = {
  load(): Promise<SupportChatLoadResult>;
  send(input: {
    body: string;
    clientMessageId: string;
    replyToMessageId: string | null;
    photo: File | null;
  }): Promise<SupportChatActionResult<{ message: SupportMessage; conversation: SupportConversationRef }>>;
  edit(messageId: string, body: string): Promise<SupportChatActionResult<{ message: SupportMessage }>>;
  remove(messageId: string): Promise<SupportChatActionResult<{ message: SupportMessage }>>;
  react(messageId: string, emoji: SupportReactionEmoji | null): Promise<SupportChatActionResult<{ message: SupportMessage }>>;
  /** Marks the thread read up to the newest message drawn. */
  markRead(upToMessageId: string | null): Promise<SupportChatActionResult<{ userLastReadAt: string | null; staffLastReadAt: string | null }>>;
  typing(typing: boolean): Promise<void>;
  /** A message not sent was let go: what the transport kept for its retry goes too. */
  forget?(clientMessageId: string): void;
};

export type SupportChatState =
  | { kind: 'loading' }
  | { kind: 'ready'; conversation: SupportConversationSummary | null; messages: SupportMessage[] }
  | { kind: 'failed' }
  | { kind: 'signed-out' }
  | { kind: 'registration-required' }
  | { kind: 'not-found' };

/** The first message that was unread when the thread opened, and how many were. */
export type SupportUnreadMark = { fromId: string; count: number } | null;

export function useSupportChat({
  viewer,
  transport,
}: {
  viewer: SupportMessageAuthor;
  transport: SupportChatTransport;
}) {
  const [state, setState] = useState<SupportChatState>({ kind: 'loading' });
  const [pending, setPending] = useState<SupportPendingMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Undefined until the first read: the divider is placed once, as the thread opened.
  const [unreadMark, setUnreadMark] = useState<SupportUnreadMark | undefined>(undefined);
  const transportRef = useRef(transport);
  const loadingRef = useRef(false);
  // A read asked for while one was on its way: run once that one lands.
  const readAgainRef = useRef(false);
  // Counts the changes this side drew; a read that left before the latest is dropped.
  const changeCountRef = useRef(0);
  // The sends, one after another: each waits for the one before to settle.
  const sendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const markingRef = useRef(false);
  const signatureRef = useRef('');
  const lastActivityRef = useRef(0);
  const lastTypingPingRef = useRef<number | null>(null);
  const hasConversationRef = useRef(false);
  // Brings the next read forward to the quick pace: set while the reading loop runs.
  const nudgeRef = useRef<(() => void) | null>(null);
  // The photos of messages on their way or not sent, by client id, for a retry.
  const photosRef = useRef(new Map<string, SupportChatPhoto>());

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  /** Something happened on this side (a send, a change): read again soon, and often for a while. */
  const noteActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    nudgeRef.current?.();
  }, []);

  const applyLoad = useCallback((result: SupportChatLoadResult) => {
    if (result.kind === 'ok') {
      const signature = supportThreadSignature(result.conversation, result.messages);
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        lastActivityRef.current = Date.now();
      }
      hasConversationRef.current = Boolean(result.conversation);
      // Each read signs the photos anew; the links already drawn are kept while they last.
      setState((current) => ({
        kind: 'ready',
        conversation: result.conversation,
        messages: withStableSupportPhotoLinks(current.kind === 'ready' ? current.messages : [], result.messages),
      }));
      // A message kept under its client id is the thread's now, whatever its
      // send answered: its copy on the way, or marked not sent, goes.
      for (const message of result.messages) {
        const photo = message.clientMessageId ? photosRef.current.get(message.clientMessageId) : undefined;
        if (!photo || !message.clientMessageId) continue;
        URL.revokeObjectURL(photo.preview.localUri);
        photosRef.current.delete(message.clientMessageId);
      }
      setPending((current) => withoutKeptPendingMessages(current, result.messages));
      setUnreadMark((current) => {
        if (current !== undefined) return current;
        const lastReadAt = viewer === 'user' ? result.conversation?.userLastReadAt : result.conversation?.staffLastReadAt;
        const unread = supportUnreadMessages(result.messages, viewer, lastReadAt ?? null);
        return unread.length > 0 ? { fromId: unread[0].id, count: unread.length } : null;
      });
      return;
    }
    if (result.kind === 'failed') {
      // A read that fails keeps what was read before; only a first read shows the error.
      setState((current) => (current.kind === 'ready' ? current : { kind: 'failed' }));
      return;
    }
    setState({ kind: result.kind });
  }, [viewer]);

  const load = useCallback(async () => {
    if (loadingRef.current) {
      // One read at a time: the one asked for now runs once this one lands.
      readAgainRef.current = true;
      return;
    }
    loadingRef.current = true;
    try {
      do {
        readAgainRef.current = false;
        const changesAtStart = changeCountRef.current;
        let result: SupportChatLoadResult;
        try {
          result = await transportRef.current.load();
        } catch {
          result = { kind: 'failed' };
        }
        // A change drawn since this read left is newer than what it read.
        if (changeCountRef.current !== changesAtStart) {
          readAgainRef.current = true;
          continue;
        }
        applyLoad(result);
      } while (readAgainRef.current);
    } finally {
      loadingRef.current = false;
    }
  }, [applyLoad]);

  /** Something this side drew changed the thread: a read already on its way is older. */
  const noteChange = useCallback(() => {
    changeCountRef.current += 1;
  }, []);

  /** Reads the thread now, for a change made elsewhere on this page (the console's status switch, a retry). */
  const reload = useCallback(() => {
    noteChange();
    return load();
  }, [load, noteChange]);

  // The thread is read again while the tab is visible, and at once when it
  // comes back; nothing is asked while it is hidden.
  useEffect(() => {
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async (own: number) => {
      await load();
      if (own !== generation || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => void run(own), supportPollDelay(lastActivityRef.current));
    };
    const stop = () => {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const restart = () => {
      stop();
      lastActivityRef.current = Date.now();
      void run(generation);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') restart();
      else stop();
    };
    // The next read at the quick pace from now, rather than after an idle wait
    // already counting down. Never from a typing ping: those come every few
    // seconds and would keep pushing the read away.
    const nudge = () => {
      if (document.visibilityState !== 'visible') return;
      stop();
      const own = generation;
      timer = setTimeout(() => void run(own), SUPPORT_POLL_ACTIVE_MS);
    };

    restart();
    nudgeRef.current = nudge;
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      nudgeRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load]);

  // Read receipts: while the thread is on screen, the other side's new
  // messages are read.
  useEffect(() => {
    if (state.kind !== 'ready' || !state.conversation || markingRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const lastReadAt = viewer === 'user' ? state.conversation.userLastReadAt : state.conversation.staffLastReadAt;
    if (supportUnreadMessages(state.messages, viewer, lastReadAt).length === 0) return;

    markingRef.current = true;
    // Read up to the newest message on screen, never one kept after it.
    void transportRef.current.markRead(state.messages[state.messages.length - 1]?.id ?? null)
      .then((result) => {
        if (!result.ok) return;
        setState((current) => (current.kind === 'ready'
          ? { ...current, conversation: withSupportReadTimes(current.conversation, result.value) }
          : current));
      })
      .catch(() => undefined)
      .finally(() => {
        markingRef.current = false;
      });
  }, [state, viewer]);

  const applyMessage = useCallback((message: SupportMessage) => {
    setState((current) => (current.kind === 'ready'
      ? { ...current, messages: withSupportMessage(current.messages, withStableSupportPhotoLinks(current.messages, [message])[0]) }
      : current));
  }, []);

  /**
   * Sends a message, or tries one that was not sent again (the same client id,
   * whose photo is kept from the first try). It is drawn at once, and goes to
   * the server after the sends written before it have settled.
   */
  const send = useCallback(async (
    body: string,
    clientMessageId: string,
    replyTo: SupportQuotedMessage | null,
    picked: SupportChatPhoto | null = null,
  ) => {
    setError(null);
    lastActivityRef.current = Date.now();
    // The server stops the writer's "typing…" with the message.
    lastTypingPingRef.current = null;
    if (picked) photosRef.current.set(clientMessageId, picked);
    const photo = picked ?? photosRef.current.get(clientMessageId) ?? null;
    setPending((current) => startPendingSupportMessage(current, {
      clientMessageId,
      body,
      now: new Date().toISOString(),
      replyTo,
      photo: photo?.preview ?? null,
    }));

    const post = async (): Promise<Awaited<ReturnType<SupportChatTransport['send']>>> => {
      try {
        return await transportRef.current.send({
          body,
          clientMessageId,
          replyToMessageId: replyTo?.id ?? null,
          photo: photo?.file ?? null,
        });
      } catch {
        return { ok: false, error: null };
      }
    };
    const turn = sendQueueRef.current.then(post);
    sendQueueRef.current = turn;
    const result = await turn;

    if (!result.ok) {
      // Kept as not sent, for a retry once signed in again too.
      setPending((current) => failPendingSupportMessage(current, clientMessageId, result.code ?? null));
      if (result.signedOut) {
        setState({ kind: 'signed-out' });
        return;
      }
      setError(result.error ?? SUPPORT_WORDS.sendFailed);
      return;
    }

    const { message, conversation } = result.value;
    hasConversationRef.current = true;
    noteChange();
    noteActivity();
    if (photo) {
      photosRef.current.delete(clientMessageId);
      // The thread draws the server's copy from here on.
      URL.revokeObjectURL(photo.preview.localUri);
    }
    setPending((current) => settlePendingSupportMessage(current, clientMessageId));
    setState((current) => (current.kind === 'ready'
      ? {
        kind: 'ready',
        conversation: withSupportConversationRef(current.conversation, conversation),
        messages: withSupportMessage(current.messages, message),
      }
      : current));
  }, [noteActivity, noteChange]);

  /** Lets a message that was not sent go: from the thread, with its photo and anything kept for its retry. */
  const discard = useCallback((clientMessageId: string) => {
    setPending((current) => settlePendingSupportMessage(current, clientMessageId));
    const photo = photosRef.current.get(clientMessageId);
    if (photo) {
      URL.revokeObjectURL(photo.preview.localUri);
      photosRef.current.delete(clientMessageId);
    }
    transportRef.current.forget?.(clientMessageId);
    setError(null);
  }, []);

  /** Runs a change drawn at once, and puts the message back if the server refuses it. */
  const change = useCallback(async (
    before: SupportMessage,
    drawn: SupportMessage,
    request: () => Promise<SupportChatActionResult<{ message: SupportMessage }>>,
  ) => {
    setError(null);
    lastActivityRef.current = Date.now();
    noteChange();
    applyMessage(drawn);
    let result: SupportChatActionResult<{ message: SupportMessage }>;
    try {
      result = await request();
    } catch {
      result = { ok: false, error: null };
    }
    noteChange();
    if (result.ok) {
      applyMessage(result.value.message);
      noteActivity();
      return true;
    }
    if (result.signedOut) {
      setState({ kind: 'signed-out' });
      return false;
    }
    applyMessage(before);
    setError(result.error ?? SUPPORT_WORDS.actionFailed);
    return false;
  }, [applyMessage, noteActivity, noteChange]);

  const react = useCallback((message: SupportMessage, emoji: SupportReactionEmoji) => {
    const toggled = supportReactionToggle(message, viewer, emoji);
    return change(message, toggled.message, () => transportRef.current.react(message.id, toggled.emoji));
  }, [change, viewer]);

  const edit = useCallback((message: SupportMessage, body: string) => (
    change(message, supportEditedMessage(message, body, new Date().toISOString()), () => transportRef.current.edit(message.id, body))
  ), [change]);

  const remove = useCallback((message: SupportMessage) => (
    change(message, supportDeletedMessage(message, new Date().toISOString()), () => transportRef.current.remove(message.id))
  ), [change]);

  /** Says "typing" while the viewer's text changes, at most every few seconds, once a conversation exists. */
  const noteTyping = useCallback(() => {
    if (!hasConversationRef.current) return;
    const now = Date.now();
    if (!supportShouldPingTyping(lastTypingPingRef.current, now)) return;
    lastTypingPingRef.current = now;
    lastActivityRef.current = now;
    void transportRef.current.typing(true).catch(() => undefined);
  }, []);

  return {
    state,
    pending,
    error,
    setError,
    unreadMark: unreadMark ?? null,
    reload,
    send,
    discard,
    react,
    edit,
    remove,
    noteTyping,
    noteActivity,
  };
}

export type SupportChatController = ReturnType<typeof useSupportChat>;
