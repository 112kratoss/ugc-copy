import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useScreenReaderRunning } from '@/components/feed-undo-notice';
import { AppText } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  readSaverNotice,
  settleSaverNotice,
  subscribeToSaverNotice,
  syncSaverNotice,
} from '@/lib/saver-notice';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * Reads, for the signed-in account, whether it has been told that creators can
 * see who saved, before its first save needs the answer (`lib/saver-notice.ts`).
 */
export function SaverNoticeSync() {
  const { api, user } = useAuth();
  const accountId = user?.id ?? null;
  useEffect(() => {
    if (accountId) void syncSaverNotice(accountId, api);
  }, [accountId, api]);
  return null;
}

/**
 * The one-line notice at an account's first save: "Creators can see who saved
 * their posts." Mounted once at the root, above every screen and in the app's
 * own window, so it draws over Home, the reel and a post alike and, unlike a
 * dialog, neither stops the clip under it nor takes another dialog's place.
 *
 * It leaves by itself after six seconds, or at OK; either way the account is
 * told, and its later saves may name it. With VoiceOver or TalkBack running it
 * waits for OK, as the feed's Undo notice does. Leaving the app before then
 * counts as not read: the next save tells them again.
 */
export function SaverNoticeBar() {
  const notice = useSyncExternalStore(subscribeToSaverNotice, readSaverNotice, readSaverNotice);
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const screenReaderRunning = useScreenReaderRunning();
  const presence = useOverlayPresence(Boolean(notice));

  const id = notice?.id ?? null;
  useEffect(() => {
    if (id === null || screenReaderRunning) return undefined;
    const timer = setTimeout(() => settleSaverNotice(id, 'expired'), SAVER_NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [id, screenReaderRunning]);

  useEffect(() => {
    if (id === null) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') settleSaverNotice(id, 'interrupted');
    });
    return () => subscription.remove();
  }, [id]);

  // Android reads the live region below as it appears; iOS has no live
  // regions, so the notice is announced once.
  useEffect(() => {
    if (id === null || Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility?.(SAVER_NOTICE_MESSAGE);
  }, [id]);

  // Still drawn while it fades out once settled.
  const [shownId, setShownId] = useState(id);
  if (id !== null && id !== shownId) setShownId(id);

  if (!presence.mounted || shownId === null) return null;

  const close = () => {
    if (id !== null) settleSaverNotice(id, 'closed');
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: insets.top + appTheme.spacing.compact,
        alignItems: 'center',
        paddingHorizontal: appTheme.spacing.screen,
      }}
    >
      <MotionView
        accessibilityLiveRegion="polite"
        accessibilityElementsHidden={id === null}
        importantForAccessibility={id !== null ? 'auto' : 'no-hide-descendants'}
        onAccessibilityEscape={close}
        pointerEvents={id !== null ? 'auto' : 'none'}
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
          {SAVER_NOTICE_MESSAGE}
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="OK"
          disabled={id === null}
          onPress={close}
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
            OK
          </AppText>
        </Pressable>
      </MotionView>
    </View>
  );
}
