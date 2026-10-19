import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Platform, View, findNodeHandle, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoticeCard, useScreenReaderRunning } from '@/components/notice-card';
import { SaverNoticeOverlay } from '@/components/saver-notice-overlay';
import { useAuth } from '@/lib/auth';
import { useOverlayPresence } from '@/lib/motion';
import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  SAVER_NOTICE_TAP_GUARD_MS,
  applySaverNoticeRecord,
  readSaverNotice,
  retrySaverNoticeRecord,
  setSaverNoticeAccount,
  settleSaverNotice,
  subscribeToSaverNotice,
} from '@/lib/saver-notice';
import { appTheme } from '@/lib/theme';
import type { ProfileResponse } from '@/lib/types';
import { viewerTopBadgeTop } from '@/lib/viewer-chrome';

/**
 * Keeps the saver notice in step with the signed-in account
 * (`lib/saver-notice.ts`). Its memory on this phone is read before its first
 * save needs it, and its record on the server arrives with the profile the app
 * loads anyway (`saverNoticeSeen`, read from the cache here). A telling not
 * yet on record is asked for again whenever the app comes back to the front,
 * and only ever for the account signed in when the request goes out. Once it
 * is on record the profile is read again, so the copy the phone keeps for the
 * next launch (`lib/persisted-account-state.ts`) says so too.
 */
export function SaverNoticeSync() {
  const { api, user, refreshProfile } = useAuth();
  const accountId = user?.id ?? null;
  const accountRef = useRef(accountId);
  useEffect(() => {
    accountRef.current = accountId;
  });

  useEffect(() => {
    void setSaverNoticeAccount(accountId, async (forAccount) => {
      // The request goes out as whoever is signed in now.
      if (accountRef.current !== forAccount) return false;
      await api.recordSaverNotice();
      // Fetched whether or not a screen is showing the profile.
      void refreshProfile();
      return true;
    });
  }, [accountId, api, refreshProfile]);

  const { data: profile } = useQuery<ProfileResponse>({
    queryKey: ['profile', accountId],
    queryFn: api.getProfile,
    enabled: false,
  });
  const seen = profile?.saverNoticeSeen;
  useEffect(() => {
    if (accountId && typeof seen === 'boolean') applySaverNoticeRecord(accountId, seen);
  }, [accountId, seen]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') retrySaverNoticeRecord(accountRef.current);
    });
    return () => subscription.remove();
  }, []);

  return null;
}

/**
 * The one-line notice at an account's first save: "Creators can see who saved
 * their posts." Mounted once at the root, it sits below the top control row of
 * every screen (the reel's Back and mute, a post's header: `viewerTopBadgeTop`),
 * so a press meant for those never lands on its OK, and it never covers them.
 *
 * It leaves at OK, or by itself after six seconds in view; either way the
 * account is told and its later saves may name it. In view: on iOS it is drawn
 * above every presented Modal (`saver-notice-overlay.ios.tsx`), and the
 * countdown stops while the app is inactive (Control Centre, a call, the app
 * switcher); on Android it stops while another window has the focus (a Modal,
 * the notification shade). With VoiceOver or TalkBack running it waits for OK,
 * as the feed's Undo notice does, and VoiceOver is moved onto it. An OK
 * pressed in its first moments is ignored: that press was on its way to what
 * was there. Leaving the app before then, or another account signing in,
 * counts as not read: the next save tells them again.
 */
export function SaverNoticeBar() {
  const notice = useSyncExternalStore(subscribeToSaverNotice, readSaverNotice, readSaverNotice);
  const insets = useSafeAreaInsets();
  const screenReaderRunning = useScreenReaderRunning();
  const presence = useOverlayPresence(Boolean(notice));
  const cardRef = useRef<View>(null);
  const id = notice?.id ?? null;

  // Followed for as long as the app runs, not only while a notice is up: a
  // notice can appear while a Modal already has the window's focus.
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  // Android only: whether the activity's window has the focus (a Modal and the
  // notification shade take it, and give it back as they go).
  const [windowFocused, setWindowFocused] = useState(true);
  useEffect(() => {
    const change = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', () => setWindowFocused(false)) : null;
    const focus = Platform.OS === 'android' ? AppState.addEventListener('focus', () => setWindowFocused(true)) : null;
    return () => {
      change.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);
  const covered = !appActive || (Platform.OS === 'android' && !windowFocused);

  useEffect(() => {
    if (id === null) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') settleSaverNotice(id, 'interrupted');
    });
    return () => subscription.remove();
  }, [id]);

  // Six seconds in view: what ran before a pause is kept.
  const remainingRef = useRef(SAVER_NOTICE_DURATION_MS);
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (id === null) return;
    remainingRef.current = SAVER_NOTICE_DURATION_MS;
    shownAtRef.current = Date.now();
  }, [id]);
  useEffect(() => {
    if (id === null || screenReaderRunning || covered) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => settleSaverNotice(id, 'expired'), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [id, screenReaderRunning, covered]);

  // VoiceOver moves onto the notice, where OK is; Android reads its live region.
  useEffect(() => {
    if (id === null || Platform.OS !== 'ios') return undefined;
    const timer = setTimeout(() => {
      const node = cardRef.current ? findNodeHandle(cardRef.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus?.(node);
    }, 250);
    return () => clearTimeout(timer);
  }, [id]);

  // Still drawn while it fades out once settled.
  const [shownId, setShownId] = useState(id);
  if (id !== null && id !== shownId) setShownId(id);

  if (!presence.mounted || shownId === null) return null;

  const read = () => {
    if (id === null || Date.now() - shownAtRef.current < SAVER_NOTICE_TAP_GUARD_MS) return;
    settleSaverNotice(id, 'closed');
  };
  const dismiss = () => {
    if (id !== null) settleSaverNotice(id, 'closed');
  };

  return (
    <SaverNoticeOverlay>
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: viewerTopBadgeTop(insets.top),
          alignItems: 'center',
          paddingHorizontal: appTheme.spacing.screen,
          zIndex: 3,
        }}
      >
        <NoticeCard
          ref={cardRef}
          message={SAVER_NOTICE_MESSAGE}
          active={id !== null}
          actionLabel="OK"
          onAction={read}
          onDismiss={dismiss}
          animatedStyle={presence.animatedStyle as StyleProp<ViewStyle>}
        />
      </View>
    </SaverNoticeOverlay>
  );
}
