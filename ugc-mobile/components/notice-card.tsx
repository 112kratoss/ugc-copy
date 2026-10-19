import { forwardRef, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, Pressable, View, type Animated, type Text, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { announceQueued } from '@/lib/accessibility-announcement';
import { MotionView } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

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
 * Announces a notice once per id on iOS, behind whatever VoiceOver is reading
 * rather than over it; Android reads the card's live region as it appears.
 */
export function useAnnounceNotice(id: string | number | null, message: string | null) {
  useEffect(() => {
    if (id === null || !message || Platform.OS !== 'ios') return;
    announceQueued(message);
  }, [id, message]);
}

/**
 * Where a transient notice sits: across the screen at `top` or `bottom`, its
 * own width capped by the card, above the screen's layers and taking no
 * touches but the card's.
 */
export function NoticePlacement({ top, bottom, children }: { top?: number; bottom?: number; children: ReactNode }) {
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top,
        bottom,
        alignItems: 'center',
        paddingHorizontal: appTheme.spacing.screen,
        zIndex: 3,
      }}
    >
      {children}
    </View>
  );
}

/**
 * The card the app's transient notices draw: the feed's Undo
 * (`feed-undo-notice.tsx`) and the saver notice (`saver-notice-bar.tsx`). One
 * line of text and one action, plus a Dismiss action for a screen reader. The
 * caller places it (`NoticePlacement`), fades it (`animatedStyle`, as
 * `useOverlayPresence` gives it) and decides when it goes.
 */
export const NoticeCard = forwardRef<Text, {
  message: string;
  /** Still drawn while it fades out once its notice has gone; inactive, it neither takes touches nor reads. */
  active: boolean;
  actionLabel: string;
  onAction: () => void;
  /** A screen reader's Dismiss action. */
  onDismiss: () => void;
  /** VoiceOver's escape gesture (a two-finger Z); the Dismiss action's when not given. */
  onEscape?: () => void;
  animatedStyle?: Animated.WithAnimatedValue<ViewStyle>;
}>(function NoticeCard({ message, active, actionLabel, onAction, onDismiss, onEscape, animatedStyle }, messageRef) {
  const theme = useAppTheme();
  return (
    <MotionView
      accessibilityLiveRegion="polite"
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      onAccessibilityEscape={onEscape ?? onDismiss}
      pointerEvents={active ? 'auto' : 'none'}
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
        animatedStyle,
      ]}
    >
      {/* The ref: where a screen reader is moved to read the notice first. */}
      <AppText ref={messageRef} variant="label" color="text" numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>
        {message}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'dismiss') onDismiss();
        }}
        disabled={!active}
        onPress={onAction}
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
          {actionLabel}
        </AppText>
      </Pressable>
    </MotionView>
  );
});
