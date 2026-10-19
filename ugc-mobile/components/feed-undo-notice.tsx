import { useEffect, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { NoticeCard, useAnnounceNotice, useScreenReaderRunning } from '@/components/notice-card';
import { useOverlayPresence } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

export { useScreenReaderRunning } from '@/components/notice-card';

/** How long a notice offers its Undo (product decision D7, 2026-10-14). */
export const FEED_UNDO_NOTICE_MS = 5_000;

export interface FeedUndoNoticeModel {
  /** New for every choice. A notice with a new id replaces the one showing, whose choice is then kept. */
  id: string;
  /** "Post hidden" or "Creator hidden" (`feedFeedbackUndoMessage` in `lib/showcase-feed-events.ts`). */
  message: string;
  /** Runs at most once for a notice, when Undo is pressed. */
  onUndo: () => void;
}

/**
 * The note that a Not interested or a Hide was made, with an Undo, above the
 * tab bar. It leaves by itself after five seconds and the choice stands;
 * Undo hands the choice back to the screen (`onUndo`), which restores the
 * post once the server has taken the choice back
 * (`undoFeedFeedback` in `lib/showcase-feed-events.ts`).
 *
 * One at a time: the screen holds a single notice, and a new one replaces the
 * old, whose choice is kept. The countdown belongs to the notice's id, so the
 * screen re-rendering does not restart it.
 *
 * With VoiceOver or TalkBack running it does not leave by itself, as
 * Material's snackbar with an action does not: five seconds is too short to
 * find the button by swiping. It still goes on Undo, on the screen's next
 * notice, or on the reader's dismiss gesture or action.
 */
export function FeedUndoNotice({
  bottomOffset,
  notice,
  onDismiss,
}: {
  /** From the bottom of the screen to the notice: above the tab bar on Home and Explore. */
  bottomOffset: number;
  notice: FeedUndoNoticeModel | null;
  /** The notice is done: its time ran out, Undo was pressed, or a reader dismissed it. Clear it if it is still this id. */
  onDismiss: (id: string) => void;
}) {
  const screenReaderRunning = useScreenReaderRunning();
  const presence = useOverlayPresence(Boolean(notice));
  // The last notice, still drawn while it fades out once the screen clears it.
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);
  const undoneId = useRef<string | null>(null);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  const id = notice?.id ?? null;
  useEffect(() => {
    if (!id || screenReaderRunning) return undefined;
    const timer = setTimeout(() => dismissRef.current(id), FEED_UNDO_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [id, screenReaderRunning]);

  useAnnounceNotice(id, notice?.message ?? null);

  if (!presence.mounted || !shown) return null;

  const dismiss = () => {
    if (notice) onDismiss(notice.id);
  };
  const undo = () => {
    if (!notice || undoneId.current === notice.id) return;
    undoneId.current = notice.id;
    notice.onUndo();
    onDismiss(notice.id);
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: bottomOffset,
        alignItems: 'center',
        paddingHorizontal: appTheme.spacing.screen,
        zIndex: 3,
      }}
    >
      <NoticeCard
        message={shown.message}
        active={Boolean(notice)}
        actionLabel="Undo"
        onAction={undo}
        onDismiss={dismiss}
        animatedStyle={presence.animatedStyle as StyleProp<ViewStyle>}
      />
    </View>
  );
}
