import { useIsFocused } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { Gift, Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Text, View } from 'react-native';

import { CLAIM_CELEBRATION_MS, ClaimSparkles, type ClaimFrame } from '@/components/claim-sparkles';
import { AppText, IconButton, PrimaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { haptic } from '@/lib/haptics';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { MotionView, useReducedMotion, useSpringState } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';
import type { WelcomeCreditResponse } from '@/lib/types';
import { primeWelcomeCredits, useWelcomeCreditsQuery } from '@/lib/use-onboarding-destination';
import {
  dismissWelcomePopupThisRun,
  shouldShowWelcomePopup,
  wasWelcomePopupDismissedThisRun,
  WELCOME_COUNT_UP_MS,
  welcomeCountUpTicks,
} from '@/lib/welcome-popup';

type Phase = 'offer' | 'claiming' | 'claimed' | 'failed';

const CARD_MAX_WIDTH = 340;
const ENTRY_SCALE = 0.9;
/**
 * The way out (owner, 2026-11-09: "a little smoother"): the page's dim fades
 * as the card and its Close settle back a touch and fade, on one even
 * ease-in-out, instead of the Modal vanishing in a single frame. (An ease-out
 * spent most of the fade in the first 100 ms and left a ghost lingering.)
 */
const EXIT_MS = 360;
const EXIT_SCALE = 0.96;
const EXIT_DROP = 12;
const EXIT_EASE = Easing.bezier(0.4, 0, 0.2, 1);
/**
 * How long the card stays once the figure lands before it closes itself
 * (owner, 2026-11-09: "make the pop up go as the confetti is popping"). The
 * sparkles burst as the figure lands and the card fades away under them; they
 * are drawn outside the fading card, so they finish over Home, and the popup
 * leaves only when the last one has gone. Under Reduce Motion there are no
 * sparkles and the figure lands at once, so the card holds longer to be read.
 */
const CLOSE_AFTER_CLAIM_MS = 150;
const CLOSE_AFTER_CLAIM_STILL_MS = 1400;
const BADGE_SIZE = 64;

/**
 * The welcome-credits popup over Home (owner, 2026-11-09): a bright card with a
 * Claim button, a quiet sparkle celebration as the figure lands, and the figure
 * counting up with haptic ticks. Offered to a named account with credits still
 * to claim; closing it waits until the next app start (`lib/welcome-popup.ts`).
 * Through a `Modal`: it holds no text field (see `components/dialog.tsx`).
 */
export function WelcomeCreditsPopup() {
  const { user } = useAuth();
  // One popup per signed-in account: a switch of account while it is up (or
  // after a claim) starts it afresh rather than showing one account's claim
  // to the next.
  return <WelcomeCreditsPopupForAccount key={user?.id ?? 'guest'} />;
}

function WelcomeCreditsPopupForAccount() {
  const { api, user, updateCredits, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const welcomeQuery = useWelcomeCreditsQuery();
  const homeFocused = useIsFocused();
  const outerTheme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [dismissed, setDismissed] = useState(() => wasWelcomePopupDismissedThisRun(user?.id));
  // Latched once offered, so the claim (which turns the answer to "claimed")
  // does not take the card away mid-celebration.
  const [offered, setOffered] = useState<WelcomeCreditResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('offer');
  const [message, setMessage] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  // Where the Claim button sits in the window: the celebration starts there.
  const [buttonFrame, setButtonFrame] = useState<ClaimFrame | null>(null);
  const countTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the last sparkle will have gone (0 when none are playing).
  const celebrationEndsAt = useRef(0);

  const eligibleNow = shouldShowWelcomePopup({
    signedIn: Boolean(user),
    welcome: welcomeQuery.data,
    homeFocused,
    dismissed,
  });
  useEffect(() => {
    if (eligibleNow && !offered && welcomeQuery.data) setOffered(welcomeQuery.data);
  }, [eligibleNow, offered, welcomeQuery.data]);
  useEffect(() => () => {
    if (countTimer.current) clearInterval(countTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const visible = Boolean(offered) && !dismissed;
  const amount = offered?.amount ?? 25;

  // 1 while the popup is up, 0 once it has gone.
  const [presence] = useState(() => new Animated.Value(1, { useNativeDriver: true }));
  const leaving = useRef(false);
  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (user) dismissWelcomePopupThisRun(user.id);
    if (reducedMotion) {
      setDismissed(true);
      return;
    }
    Animated.timing(presence, { toValue: 0, duration: EXIT_MS, easing: EXIT_EASE, useNativeDriver: true })
      .start(() => {
        // The sparkles live in this Modal: let them finish before it goes.
        const remaining = celebrationEndsAt.current - Date.now();
        if (remaining <= 0) setDismissed(true);
        else closeTimer.current = setTimeout(() => setDismissed(true), remaining);
      });
  };

  // Claim, the celebration, then the card closes by itself (owner, 2026-11-09).
  const closeSoon = (afterMs: number) => {
    closeTimer.current = setTimeout(close, afterMs);
  };

  const countUp = (to: number) => {
    if (reducedMotion) {
      setCount(to);
      haptic.success();
      closeSoon(CLOSE_AFTER_CLAIM_STILL_MS);
      return;
    }
    const ticks = welcomeCountUpTicks(to);
    const started = Date.now();
    let passed = 0;
    setCount(0);
    countTimer.current = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / WELCOME_COUNT_UP_MS);
      const value = Math.round(to * progress);
      setCount(value);
      while (passed < ticks.length && value >= ticks[passed]) {
        passed += 1;
        haptic.select();
      }
      if (progress >= 1) {
        if (countTimer.current) clearInterval(countTimer.current);
        countTimer.current = null;
        haptic.success();
        celebrationEndsAt.current = Date.now() + CLAIM_CELEBRATION_MS;
        closeSoon(CLOSE_AFTER_CLAIM_MS);
      }
    }, 32);
  };

  const claim = async () => {
    if (!user || phase === 'claiming') return;
    haptic.light();
    setPhase('claiming');
    setMessage(null);
    try {
      const result = await api.claimWelcomeCredits();
      primeWelcomeCredits(queryClient, user.id, result);
      if (result.status === 'claimed' || result.status === 'already_claimed') {
        if (result.status === 'claimed') updateCredits(result.credits);
        else void refreshProfile().catch(() => undefined);
        setPhase('claimed');
        countUp(result.amount);
        AccessibilityInfo.announceForAccessibility(`${result.amount} credits added to your balance.`);
      } else {
        setPhase('failed');
        setMessage('These credits can’t be claimed on this account.');
      }
    } catch (error) {
      haptic.error();
      setPhase('failed');
      setMessage(error instanceof Error ? error.message : 'Could not add your credits. Try again.');
    }
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={close}>
      {visible ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: appTheme.spacing.section, gap: appTheme.spacing.screen }}>
          <Animated.View style={{ position: 'absolute', inset: 0, backgroundColor: outerTheme.colors.overlay, opacity: presence }} />
          <Animated.View
            style={{
              width: '100%',
              alignItems: 'center',
              gap: appTheme.spacing.screen,
              opacity: presence,
              transform: [
                { translateY: presence.interpolate({ inputRange: [0, 1], outputRange: [EXIT_DROP, 0] }) },
                { scale: presence.interpolate({ inputRange: [0, 1], outputRange: [EXIT_SCALE, 1] }) },
              ],
            }}
          >
            <ThemeScope scheme="light">
              <WelcomeCard
                amount={amount}
                phase={phase}
                count={count}
                message={message}
                onClaim={(frame) => {
                  setButtonFrame(frame);
                  void claim();
                }}
              />
              <CloseChip disabled={phase === 'claiming'} onPress={close} />
            </ThemeScope>
          </Animated.View>
          <ClaimSparkles play={phase === 'claimed' && count >= amount} frame={buttonFrame} />
        </View>
      ) : null}
    </Modal>
  );
}

/**
 * The way out, below the card as on Kling's: the app's shared Close control,
 * on a white disc so it reads over any dimmed page.
 */
function CloseChip({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surfaceInset }}>
      <IconButton icon={CloseGlyph} label="Close" onPress={onPress} disabled={disabled} />
    </View>
  );
}

/** iOS draws a one-sided dashed border solid, so the divider is drawn as dashes. */
function DashedRule() {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', overflow: 'hidden' }}>
      {Array.from({ length: 34 }, (_, index) => (
        <View key={index} style={{ width: appTheme.spacing.unit, height: 1, backgroundColor: theme.colors.borderStrong }} />
      ))}
    </View>
  );
}

/** An onLayout that records a block's first height and ignores later ones. */
function keepFirstHeight(set: (update: (previous: number | undefined) => number | undefined) => void) {
  return (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = event.nativeEvent.layout.height;
    set((previous) => previous ?? height);
  };
}

function WelcomeCard({
  amount,
  phase,
  count,
  message,
  onClaim,
}: {
  amount: number;
  phase: Phase;
  count: number;
  message: string | null;
  onClaim: (buttonFrame: ClaimFrame | null) => void;
}) {
  const theme = useAppTheme();
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const progress = useSpringState(entered);
  const scale = progress ? progress.interpolate({ inputRange: [0, 1], outputRange: [ENTRY_SCALE, 1] }) : 1;
  const claimed = phase === 'claimed';
  const buttonRef = useRef<View | null>(null);
  // The heading and the note keep the height they first had: the shorter
  // claimed words must not shrink the card, or the button jumps up and the
  // celebration starts where it used to be.
  const [headingHeight, setHeadingHeight] = useState<number | undefined>(undefined);
  const [noteHeight, setNoteHeight] = useState<number | undefined>(undefined);
  const reducedMotion = useReducedMotion();
  const [pop] = useState(() => new Animated.Value(1, { useNativeDriver: true }));
  const landed = claimed && count >= amount;
  useEffect(() => {
    if (!landed || reducedMotion) return;
    // One soft pop as the figure lands: up fast, settle slow, no bounce.
    const settle = Animated.sequence([
      Animated.timing(pop, { toValue: 1.08, duration: 140, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }),
      Animated.timing(pop, { toValue: 1, duration: 360, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }),
    ]);
    settle.start();
    return () => settle.stop();
  }, [landed, pop, reducedMotion]);

  return (
    <MotionView
      accessibilityViewIsModal
      style={{
        width: '100%',
        maxWidth: CARD_MAX_WIDTH,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        backgroundColor: theme.colors.selected,
        borderWidth: 1,
        borderColor: theme.colors.selectedStrong,
        paddingTop: appTheme.spacing.panel,
        paddingHorizontal: appTheme.spacing.screen,
        paddingBottom: appTheme.spacing.screen,
        gap: appTheme.spacing.screen,
        overflow: 'hidden',
        opacity: progress ?? 1,
        transform: [{ scale }],
      }}
    >
      {/* A large soft glyph in the corner, as Kling's card carries its mark. */}
      <View pointerEvents="none" style={{ position: 'absolute', right: -appTheme.spacing.section, top: -appTheme.spacing.compact }}>
        <Sparkles size={appTheme.icon.hero * 4} color={theme.colors.selectedStrong} />
      </View>

      <View
        onLayout={keepFirstHeight(setHeadingHeight)}
        style={{ alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact, minHeight: headingHeight }}
      >
        <LinearGradient
          colors={[theme.colors.navigationCreateTop, theme.colors.navigationCreateBottom]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: BADGE_SIZE, height: BADGE_SIZE, borderRadius: appTheme.radii.pill, alignItems: 'center', justifyContent: 'center' }}
        >
          <Gift size={appTheme.icon.hero} color={theme.colors.onPrimary} />
        </LinearGradient>
        <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>
          {claimed ? 'Credits added!' : 'Claim your welcome credits'}
        </AppText>
        <AppText variant="label" color="primary" style={{ textAlign: 'center' }}>
          {claimed ? 'Go make something amazing' : 'Free credits to start creating'}
        </AppText>
      </View>

      <DashedRule />

      <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: theme.colors.surfaceInset, overflow: 'hidden' }}>
        <Animated.View
          accessible
          accessibilityLabel={`${claimed ? count : amount} creation credits`}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact, paddingVertical: appTheme.spacing.screen, transform: [{ scale: pop }] }}
        >
          <Sparkles size={appTheme.icon.feature} color={theme.colors.primaryFill} />
          <AppText variant="display" color="primary" style={{ fontVariant: ['tabular-nums'] }}>
            {claimed ? `+${count}` : amount}
          </AppText>
          <AppText variant="bodySm">creation credits</AppText>
        </Animated.View>
      </View>

      <View onLayout={keepFirstHeight(setNoteHeight)} style={{ justifyContent: 'center', minHeight: noteHeight }}>
        <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
          {claimed
            ? 'They’re in your balance now.'
            : 'This welcome gift can only be used for creating media. It can’t be used to buy recipes or resources.'}
        </AppText>
      </View>

      {message ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.danger, textAlign: 'center' }}>{message}</Text>
      ) : null}

      <View ref={buttonRef} collapsable={false}>
        <PrimaryButton
          label={claimed ? 'Claimed' : phase === 'failed' ? 'Try again' : 'Claim'}
          loading={phase === 'claiming'}
          disabled={claimed}
          onPress={() => {
            const button = buttonRef.current;
            if (!button?.measureInWindow) {
              onClaim(null);
              return;
            }
            button.measureInWindow((x, y, width, height) => onClaim({ x, y, width, height }));
          }}
        />
      </View>
    </MotionView>
  );
}
