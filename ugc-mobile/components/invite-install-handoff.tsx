import * as Clipboard from 'expo-clipboard';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NoticePlacement, useAnnounceNotice } from '@/components/notice-card';
import { SaverNoticeOverlay } from '@/components/saver-notice-overlay';
import { AppText } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { isFirstOpenIntroShowing, subscribeFirstOpenIntro } from '@/lib/first-open-intro';
import {
  decideInstallHandoff,
  inviteHandoffRoute,
  markInstallHandoffSettled,
  readInstallHandoffSettled,
  readInstallReferrerInvite,
  readInstallTime,
  readPastedInvite,
  recordInstallHandoff,
  shouldOpenHandoffScreen,
  type InstallHandoffOutcome,
} from '@/lib/invite-install-handoff';
import type { InviteInstallHandoff } from '@/lib/invite-share-link/invite-install-handoff';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { viewerTopBadgeTop } from '@/lib/viewer-chrome';
import { readWelcomePromise } from '@/lib/welcome-promise';

/** What the iPhone's offer says, and what it says once Paste has been tapped. */
export const INVITE_PASTE_OFFER_TITLE = 'Opened an invite before installing?';
export const INVITE_PASTE_OFFER_BODY = 'Tap Paste to keep it. Whoever invited you may earn bonus credits if you join.';
export const INVITE_PASTE_WORKING = 'Keeping your invite…';
export const INVITE_PASTE_NOT_AN_INVITE = 'That wasn’t an invite link, so nothing was kept.';
/**
 * What the card says once the invite has been tried, by what became of it. The
 * bonus is the program's: it comes with the first credit top-up, not with
 * joining (review of 2026-11-11: "Join to get your bonus" promised more).
 */
export const INVITE_PASTE_RESULTS: Record<InstallHandoffOutcome, string> = {
  kept: 'Invite kept. Your first credit top-up gets its bonus.',
  'kept-earlier': 'An earlier invite on this phone is the one kept.',
  unavailable: 'That invite is no longer available, so nothing was kept.',
  saved: 'Invite saved on this phone. It will be recorded once you’re online.',
};
/** How long the line after a paste stays. */
export const INVITE_PASTE_RESULT_MS = 4000;

type Offer = 'offered' | 'working' | 'not-an-invite' | InstallHandoffOutcome | null;

/** How an invite reached the app, as the `step` of a funnel event: counts only, never a code. */
type HandoffStep = 'play_referrer' | 'paste_offered' | 'paste_used' | 'paste_not_invite' | 'paste_dismissed';

/**
 * Looks, once per install, for the invite the web handed over before the app
 * was installed (`lib/invite-install-handoff.ts`), and opens what it finds.
 * Mounted once at the root. It draws nothing on Android, and on an iPhone only
 * the offer to paste a link that is waiting, after the first-open intro has
 * left the screen.
 */
export function InviteInstallHandoff() {
  const { api, user, isLoading } = useAuth();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const introShowing = useSyncExternalStore(subscribeFirstOpenIntro, isFirstOpenIntroShowing, isFirstOpenIntroShowing);
  const [settled, setSettled] = useState<boolean | null>(null);
  const [neverSignedIn, setNeverSignedIn] = useState<boolean | null>(null);
  const [installedAt, setInstalledAt] = useState<number | null | undefined>(Platform.OS === 'ios' ? undefined : null);
  const [offer, setOffer] = useState<Offer>(null);
  // When this launch began: read once, so a render reads no clock.
  const [launchedAt] = useState(() => Date.now());
  const looked = useRef(false);
  const offerCounted = useRef(false);
  const hasUser = Boolean(user);
  // The screen in front when an invite arrives, read then and not at render.
  const pathname = usePathname();
  const shownInvite = useGlobalSearchParams<{ r?: string | string[] }>().r;
  const front = useRef({ pathname, shownInvite });
  useEffect(() => {
    front.current = { pathname, shownInvite };
  });

  useEffect(() => {
    let live = true;
    void readInstallHandoffSettled().then((value) => {
      if (live) setSettled(value);
    });
    void readWelcomePromise().then((value) => {
      if (live) setNeverSignedIn(value);
    });
    if (Platform.OS === 'ios') {
      void readInstallTime().then((value) => {
        if (live) setInstalledAt(value);
      });
    }
    return () => {
      live = false;
    };
  }, []);

  const settle = useCallback(() => {
    setSettled(true);
    void markInstallHandoffSettled();
  }, []);

  const count = useCallback((step: HandoffStep) => {
    void trackOnboardingEvent(api, 'screen_viewed', { step: `invite_handoff_${step}` }).catch(() => undefined);
  }, [api]);

  // Records the invite, then opens the screen its link would have opened: that
  // screen finds the visit on the phone and makes no second (review of
  // 2026-11-11: recorded here and by the landing at once, a visit was sent twice).
  const accept = useCallback(async (handoff: InviteInstallHandoff, via: 'referrer' | 'paste') => {
    const outcome = await recordInstallHandoff(api, handoff);
    const shown = front.current.shownInvite;
    const open = outcome !== 'unavailable' && shouldOpenHandoffScreen({
      via,
      handoff,
      pathname: front.current.pathname,
      shownInvite: Array.isArray(shown) ? shown[0] : shown,
    });
    // expo-router holds a push made before the navigator is ready, and makes it then.
    if (open) router.push(inviteHandoffRoute(handoff) as never);
    return outcome;
  }, [api]);

  const step = decideInstallHandoff({
    platform: Platform.OS,
    settled,
    authLoading: isLoading,
    hasUser,
    neverSignedIn,
    installedAt,
    now: launchedAt,
  });

  useEffect(() => {
    if (looked.current || step === 'wait') return;
    looked.current = true;
    if (step === 'skip') {
      if (settled === false) settle();
      return;
    }
    if (step === 'read-referrer') {
      void readInstallReferrerInvite().then(({ read, handoff }) => {
        if (!read) {
          // Play could not be asked: the next start asks again.
          looked.current = false;
          return;
        }
        settle();
        if (!handoff) return;
        count('play_referrer');
        void accept(handoff, 'referrer');
      });
      return;
    }
    // An iPhone: is a link waiting? The question reads nothing and shows no prompt.
    if (!Clipboard.isPasteButtonAvailable) {
      settle();
      return;
    }
    void Clipboard.hasUrlAsync().then(
      (waiting) => {
        if (waiting) setOffer('offered');
        else settle();
      },
      () => settle(),
    );
  }, [accept, count, settle, settled, step]);

  // An account signed in while the offer was up: it has no invite to keep.
  useEffect(() => {
    if (hasUser && offer === 'offered') {
      setOffer(null);
      settle();
    }
  }, [hasUser, offer, settle]);

  const visible = offer !== null && !introShowing;
  useEffect(() => {
    if (!visible || offer !== 'offered' || offerCounted.current) return;
    offerCounted.current = true;
    count('paste_offered');
  }, [count, offer, visible]);

  useEffect(() => {
    if (offer === null || offer === 'offered' || offer === 'working') return undefined;
    const timer = setTimeout(() => setOffer(null), INVITE_PASTE_RESULT_MS);
    return () => clearTimeout(timer);
  }, [offer]);

  const presence = useOverlayPresence(visible);
  const [shown, setShown] = useState<Offer>(offer);
  if (offer && offer !== shown) setShown(offer);
  const message = shown === null || shown === 'offered'
    ? INVITE_PASTE_OFFER_TITLE
    : shown === 'working'
      ? INVITE_PASTE_WORKING
      : shown === 'not-an-invite'
        ? INVITE_PASTE_NOT_AN_INVITE
        : INVITE_PASTE_RESULTS[shown];
  useAnnounceNotice(visible ? shown : null, visible ? message : null);

  if (!presence.mounted || !shown) return null;

  const paste = (pasted: { type?: unknown; text?: unknown }) => {
    if (offer !== 'offered') return;
    settle();
    const handoff = readPastedInvite(pasted);
    if (!handoff) {
      count('paste_not_invite');
      setOffer('not-an-invite');
      return;
    }
    count('paste_used');
    setOffer('working');
    void accept(handoff, 'paste').then(setOffer);
  };
  const notNow = () => {
    if (offer !== 'offered') return;
    count('paste_dismissed');
    settle();
    setOffer(null);
  };
  const active = visible && offer === 'offered';

  return (
    <SaverNoticeOverlay>
      <NoticePlacement top={viewerTopBadgeTop(insets.top)}>
        <MotionView
          accessibilityLiveRegion="polite"
          accessibilityElementsHidden={!visible}
          importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
          onAccessibilityEscape={notNow}
          pointerEvents={visible ? 'auto' : 'none'}
          style={[
            {
              width: '100%',
              maxWidth: 480,
              gap: appTheme.spacing.compact,
              padding: appTheme.spacing.card,
              borderRadius: appTheme.radii.md,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              backgroundColor: theme.colors.panel,
              boxShadow: theme.shadow.floating.boxShadow,
            },
            presence.animatedStyle,
          ]}
        >
          <AppText variant="label" color="text">{message}</AppText>
          {shown === 'offered' ? (
            <>
              <AppText variant="caption" color="textSecondary">{INVITE_PASTE_OFFER_BODY}</AppText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.gap }}>
                {/* Apple's own control: the system reads the clipboard at this tap, with no prompt. */}
                <Clipboard.ClipboardPasteButton
                  acceptedContentTypes={['plain-text', 'url']}
                  backgroundColor={theme.colors.primaryFill}
                  foregroundColor={theme.colors.onPrimary}
                  cornerStyle="capsule"
                  displayMode="iconAndLabel"
                  onPress={paste}
                  style={{ height: appTheme.touch.compact, width: 132 }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Not now"
                  disabled={!active}
                  onPress={notNow}
                  style={({ pressed }) => ({
                    minHeight: appTheme.touch.compact,
                    minWidth: 72,
                    paddingHorizontal: appTheme.spacing.gap,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: appTheme.radii.pill,
                    backgroundColor: pressed ? theme.colors.pressed : 'transparent',
                  })}
                >
                  <AppText selectable={false} variant="button" color="primary">Not now</AppText>
                </Pressable>
              </View>
            </>
          ) : null}
        </MotionView>
      </NoticePlacement>
    </SaverNoticeOverlay>
  );
}
