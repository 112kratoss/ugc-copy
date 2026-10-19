import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

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
 * Whether VoiceOver or TalkBack is running. Read once and then followed, so a
 * reader turned on while a notice is up keeps it.
 */
export function useScreenReaderRunning() {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isScreenReaderEnabled?.()
      ?.then((value) => {
        if (current) setRunning(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.('screenReaderChanged', setRunning);
    return () => {
      current = false;
      subscription?.remove?.();
    };
  }, []);
  return running;
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
  const theme = useAppTheme();
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
  const message = notice?.message ?? null;
  useEffect(() => {
    if (!id || screenReaderRunning) return undefined;
    const timer = setTimeout(() => dismissRef.current(id), FEED_UNDO_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [id, screenReaderRunning]);

  // Android reads the live region below as it appears; iOS has no live
  // regions, so the message is announced once per notice.
  useEffect(() => {
    if (!id || !message || Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility?.(message);
  }, [id, message]);

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
      <MotionView
        accessibilityLiveRegion="polite"
        accessibilityElementsHidden={!notice}
        importantForAccessibility={notice ? 'auto' : 'no-hide-descendants'}
        onAccessibilityEscape={dismiss}
        pointerEvents={notice ? 'auto' : 'none'}
        style={[
          {
            width: '100%',
            maxWidth: 480,
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            gap: appTheme.spacing.compact,
            paddingLeft: appTheme.spacing.card,
            paddingRight: appTheme.spacing.unit,
            borderRadius: appTheme.radii.md,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderStrong,
            backgroundColor: theme.colors.panel,
            boxShadow: theme.shadow.floating.boxShadow,
          },
          presence.animatedStyle as StyleProp<ViewStyle>,
        ]}
      >
        <AppText variant="label" color="text" numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>
          {shown.message}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Undo"
          accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'dismiss') dismiss();
          }}
          disabled={!notice}
          onPress={undo}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.compact,
            minWidth: 72,
            paddingHorizontal: appTheme.spacing.gap,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: appTheme.radii.sm,
            backgroundColor: pressed ? theme.colors.pressed : 'transparent',
          })}
        >
          <AppText selectable={false} variant="button" color="primary">
            Undo
          </AppText>
        </Pressable>
      </MotionView>
    </View>
  );
}
