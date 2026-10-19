import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Platform, findNodeHandle, type Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoticeCard, NoticePlacement, useScreenReaderRunning } from '@/components/notice-card';
import { SaverNoticeOverlay } from '@/components/saver-notice-overlay';
import { subscribeToAppForeground, useWindowInView } from '@/lib/app-foreground';
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
import type { ProfileResponse } from '@/lib/types';
import { viewerTopBadgeTop } from '@/lib/viewer-chrome';

/**
 * The profile the app keeps, in the cache and for the next launch
 * (`lib/persisted-account-state.ts`, which saves whatever the cache is given),
 * now says the account's telling is on record, without reading it all again.
 */
function markSaverNoticeSeen(queryClient: QueryClient, accountId: string) {
  queryClient.setQueryData<ProfileResponse>(['profile', accountId], (profile) => (
    profile && profile.saverNoticeSeen !== true ? { ...profile, saverNoticeSeen: true } : profile
  ));
}

/**
 * Keeps the saver notice in step with the signed-in account
 * (`lib/saver-notice.ts`). Its memory on this phone is read before its first
 * save needs it, and its record on the server arrives with the profile the app
 * loads anyway (`saverNoticeSeen`, read from the cache here). A telling not
 * yet on record is asked for again whenever the app comes back to the front,
 * and only ever for the account signed in when the request goes out.
 */
export function SaverNoticeSync() {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();
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
      markSaverNoticeSeen(queryClient, forAccount);
      return true;
    });
  }, [accountId, api, queryClient]);

  const { data: profile } = useQuery<ProfileResponse>({
    queryKey: ['profile', accountId],
    queryFn: api.getProfile,
    enabled: false,
  });
  const seen = profile?.saverNoticeSeen;
  useEffect(() => {
    if (!accountId || typeof seen !== 'boolean') return;
    // Set aside: a profile read before this phone's record landed. The copy
    // kept for the next launch must not say otherwise either.
    if (!applySaverNoticeRecord(accountId, seen)) markSaverNoticeSeen(queryClient, accountId);
  }, [accountId, seen, queryClient]);

  useEffect(() => subscribeToAppForeground((foreground) => {
    if (foreground) retrySaverNoticeRecord(accountRef.current);
  }), []);

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
 * the notification shade): `useWindowInView`. With VoiceOver or TalkBack
 * running it waits for OK, as the feed's Undo notice does, and VoiceOver is
 * moved onto its words, with OK the next swipe. An OK, or a reader's Dismiss
 * action, in its first moments is ignored: that press was on its way to what
 * was there. Leaving the app before then, VoiceOver's escape gesture, or
 * another account signing in counts as not read: the next save tells them
 * again.
 */
export function SaverNoticeBar() {
  const notice = useSyncExternalStore(subscribeToSaverNotice, readSaverNotice, readSaverNotice);
  const insets = useSafeAreaInsets();
  const screenReaderRunning = useScreenReaderRunning();
  const inView = useWindowInView();
  // Still drawn while it fades out once settled.
  const presence = useOverlayPresence(Boolean(notice));
  const messageRef = useRef<Text>(null);
  const id = notice?.id ?? null;

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
    if (id === null || screenReaderRunning || !inView) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => settleSaverNotice(id, 'expired'), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [id, screenReaderRunning, inView]);

  // VoiceOver reads the notice's words first; Android reads its live region.
  useEffect(() => {
    if (id === null || Platform.OS !== 'ios') return undefined;
    const timer = setTimeout(() => {
      const node = messageRef.current ? findNodeHandle(messageRef.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus?.(node);
    }, 250);
    return () => clearTimeout(timer);
  }, [id]);

  if (!presence.mounted) return null;

  const read = () => {
    if (id === null || Date.now() - shownAtRef.current < SAVER_NOTICE_TAP_GUARD_MS) return;
    settleSaverNotice(id, 'closed');
  };
  const escape = () => {
    if (id !== null) settleSaverNotice(id, 'interrupted');
  };

  return (
    <SaverNoticeOverlay>
      <NoticePlacement top={viewerTopBadgeTop(insets.top)}>
        <NoticeCard
          ref={messageRef}
          message={SAVER_NOTICE_MESSAGE}
          active={id !== null}
          actionLabel="OK"
          onAction={read}
          onDismiss={read}
          onEscape={escape}
          animatedStyle={presence.animatedStyle}
        />
      </NoticePlacement>
    </SaverNoticeOverlay>
  );
}
