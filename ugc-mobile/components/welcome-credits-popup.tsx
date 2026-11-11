import { useQueryClient } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname } from 'expo-router';
import { Check, Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Modal, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { CLAIM_CONFETTI_MS, ClaimConfetti, type ClaimOrigin } from '@/components/claim-confetti';
import { AppText, IconButton, PrimaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { haptic } from '@/lib/haptics';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { MotionView, useReducedMotion, useSpringState } from '@/lib/motion';
import { getLatestReferralClaimRecord, inviteClaimLine } from '@/lib/referral-attribution';
import { appTheme } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';
import type { WelcomeCreditResponse } from '@/lib/types';
import { primeWelcomeCredits, useWelcomeCreditsQuery } from '@/lib/use-onboarding-destination';
import {
  dismissWelcomePopupThisRun,
  isWelcomePopupPlace,
  shouldShowWelcomePopup,
  useWelcomeReturnPath,
  wasWelcomePopupDismissedThisRun,
  welcomeCountUpTicks,
  welcomeFillProgress,
} from '@/lib/welcome-popup';

/** `failed` offers a retry; `refused` is the server's final no, with only Close left. */
type Phase = 'offer' | 'claiming' | 'claimed' | 'failed' | 'refused';

const CARD_MAX_WIDTH = 340;
const ENTRY_SCALE = 0.9;
/** The ring around the badge: its box, the track's radius and its stroke. */
const RING_SIZE = 108;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const BADGE_SIZE = 72;
const FIGURE_SIZE = 60;
const FIGURE_LINE = 68;
/**
 * The way out (owner, 2026-11-09: "as the confetti is popping the pop up is
 * closing down smoothly"): a beat after the figure lands and the confetti
 * bursts, the dim fades while the card and its Close sink back and fade on one
 * even ease-in-out. The confetti is drawn outside the fading card and keeps
 * falling over Home; the Modal goes only once the last piece has.
 */
const EXIT_AFTER_LANDING_MS = 260;
const EXIT_MS = 420;
const EXIT_SCALE = 0.92;
const EXIT_DROP = 24;
const EXIT_EASE = Easing.bezier(0.4, 0, 0.2, 1);
/** Under Reduce Motion there is no fill and no confetti: the card holds to be read. */
const EXIT_AFTER_LANDING_STILL_MS = 1400;
/** The figure's pop as it lands: up fast, then a springy settle. */
const POP_SCALE = 1.16;
const POP_EASE = Easing.bezier(0.34, 1.56, 0.64, 1);

/**
 * The welcome-credits popup, over Home and over the screen a sign-up went back
 * to, mounted once in the root layout (owner, 2026-11-09, redesigned the same
 * day: "the credits increasing with the haptics ... like games with filling
 * animations", confetti "with a premium feel which gives the user the
 * satisfaction of gaining something", the popup closing as the confetti pops).
 *
 * A white card: a coral badge inside a ring, the credits as a large figure
 * under it, the title, a note and Claim. On Claim the ring fills and the figure
 * counts up from 0 as a game's counter does, a haptic tick per credit, fast
 * off the mark and slowing into the landing; as it lands the figure and badge
 * pop, the balance in the header jumps, and confetti bursts out of the figure
 * while the card sinks away beneath it. Offered to a named account with credits
 * still to claim, on Home and on the screen a sign-up went back to (a sign-up
 * asked for on a creator offers the credits there, not a top-up);
 * closing it waits until the next app start
 * (`lib/welcome-popup.ts`). Through a `Modal`: it holds no text field (see
 * `components/dialog.tsx`).
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
  // Home, or the screen a finished sign-up went back to (`lib/welcome-popup.ts`).
  const pathname = usePathname();
  const returnedTo = useWelcomeReturnPath();
  const outerTheme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [dismissed, setDismissed] = useState(() => wasWelcomePopupDismissedThisRun(user?.id));
  // Latched once offered, so the claim (which turns the answer to "claimed")
  // does not take the card away mid-celebration.
  const [offered, setOffered] = useState<WelcomeCreditResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('offer');
  const [message, setMessage] = useState<string | null>(null);
  // What the claim granted: the fill's target, once the server has answered.
  const [granted, setGranted] = useState<number | null>(null);
  // How far the fill has got, 0..1, and the credits shown so far.
  const [fill, setFill] = useState(0);
  const [count, setCount] = useState(0);
  // Where the credits figure sits in the window: the confetti bursts out of
  // it. Read through the ref by the fill's timers, whose closures predate it.
  const [origin, setOriginState] = useState<ClaimOrigin | null>(null);
  const originRef = useRef<ClaimOrigin | null>(null);
  const setOrigin = (next: ClaimOrigin | null) => {
    originRef.current = next;
    setOriginState(next);
  };
  const fillTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // The new balance, held back until the figure lands so the header jumps
  // with it.
  const pendingBalance = useRef<number | null>(null);
  // When the last piece of confetti will have fallen (0 when none is flying).
  const confettiEndsAt = useRef(0);

  const eligibleNow = shouldShowWelcomePopup({
    signedIn: Boolean(user),
    welcome: welcomeQuery.data,
    offeredHere: isWelcomePopupPlace({ pathname, returnedTo }),
    dismissed,
  });
  useEffect(() => {
    if (eligibleNow && !offered && welcomeQuery.data) setOffered(welcomeQuery.data);
  }, [eligibleNow, offered, welcomeQuery.data]);
  // What became of the invite the sign-up claimed, unseen, as the account was
  // made (`lib/auth.tsx`): the card greeting the new account says it, as the
  // web's greeting page does (owner, 2026-11-11). Read once the card is offered.
  const [inviteLine, setInviteLine] = useState<ReturnType<typeof inviteClaimLine>>(null);
  const isOffered = Boolean(offered);
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!isOffered || !userId) return;
    let live = true;
    void getLatestReferralClaimRecord(userId)
      .then((record) => {
        if (live) setInviteLine(inviteClaimLine(record));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isOffered, userId]);
  useEffect(() => () => {
    mounted.current = false;
    if (fillTimer.current) clearInterval(fillTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // A fill cut short (an account switch): the claim is in, so
    // the current account's profile is read again. Never `updateCredits`
    // here: that would write one account's balance over the next one's.
    if (pendingBalance.current !== null) void refreshProfile().catch(() => undefined);
  }, [refreshProfile]);

  const visible = Boolean(offered) && !dismissed;
  // The figure: what was offered, then what the claim granted.
  const amount = granted ?? offered?.amount ?? 25;
  const landed = phase === 'claimed' && count >= amount;
  // While the claim is in flight or filling, neither Close nor Android's
  // back key may take the card away: a failed claim would land on a hidden
  // Modal with no retry.
  const busy = phase === 'claiming' || (phase === 'claimed' && !landed);

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
        // The confetti lives in this Modal: let it fall before the Modal goes.
        const remaining = confettiEndsAt.current - Date.now();
        if (remaining <= 0) setDismissed(true);
        else closeTimer.current = setTimeout(() => setDismissed(true), remaining);
      });
  };

  const land = (to: number) => {
    setFill(1);
    setCount(to);
    haptic.success();
    if (pendingBalance.current !== null) {
      updateCredits(pendingBalance.current);
      pendingBalance.current = null;
    }
    if (reducedMotion) {
      closeTimer.current = setTimeout(close, EXIT_AFTER_LANDING_STILL_MS);
      return;
    }
    // No origin (the figure could not be measured): no burst, nothing to wait for.
    confettiEndsAt.current = originRef.current ? Date.now() + CLAIM_CONFETTI_MS + 100 : 0;
    closeTimer.current = setTimeout(close, EXIT_AFTER_LANDING_MS);
  };

  const fillUp = (to: number) => {
    if (reducedMotion) {
      land(to);
      return;
    }
    const ticks = welcomeCountUpTicks(to);
    const started = Date.now();
    let passed = 0;
    setFill(0);
    setCount(0);
    fillTimer.current = setInterval(() => {
      const progress = welcomeFillProgress(Date.now() - started);
      if (progress >= 1) {
        if (fillTimer.current) clearInterval(fillTimer.current);
        fillTimer.current = null;
        land(to);
        return;
      }
      const value = Math.floor(to * progress);
      setFill(progress);
      setCount(value);
      while (passed < ticks.length && value >= ticks[passed]) {
        passed += 1;
        haptic.select();
      }
    }, 16);
  };

  const claim = async () => {
    if (!user || phase === 'claiming') return;
    haptic.light();
    setPhase('claiming');
    setMessage(null);
    try {
      const result = await api.claimWelcomeCredits();
      primeWelcomeCredits(queryClient, user.id, result);
      // Gone meanwhile (an account switch): the claim is recorded for the
      // account that made it; nothing here may start timers or touch state.
      if (!mounted.current) return;
      if (result.status === 'claimed' || result.status === 'already_claimed') {
        if (result.status === 'claimed') pendingBalance.current = result.credits;
        else void refreshProfile().catch(() => undefined);
        setGranted(result.amount);
        setPhase('claimed');
        fillUp(result.amount);
        AccessibilityInfo.announceForAccessibility(`${result.amount} credits added to your balance.`);
      } else {
        // The server's final answer: nothing to retry.
        setPhase('refused');
        setMessage('These credits can’t be claimed on this account.');
      }
    } catch (error) {
      if (!mounted.current) return;
      haptic.error();
      setPhase('failed');
      setMessage(error instanceof Error ? error.message : 'Could not add your credits. Try again.');
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="none"
      onRequestClose={() => {
        if (!busy) close();
      }}
    >
      {visible ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: appTheme.spacing.section, gap: appTheme.spacing.screen }}>
          <Animated.View style={{ position: 'absolute', inset: 0, backgroundColor: outerTheme.colors.overlay, opacity: presence }} />
          {/* The card and its Close together are what VoiceOver is held to. */}
          <Animated.View
            accessibilityViewIsModal
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
                fill={fill}
                count={count}
                message={message}
                inviteLine={inviteLine}
                onClaim={claim}
                onFigureMeasured={setOrigin}
              />
              <CloseChip disabled={busy} onPress={close} />
            </ThemeScope>
          </Animated.View>
          {/* Over the whole window, outside the sinking card, in the card's own light palette. */}
          <ThemeScope scheme="light">
            <ClaimConfetti ready={phase === 'claiming' || phase === 'claimed'} play={landed} origin={origin} />
          </ThemeScope>
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

/** An onLayout that records a block's first height and ignores later ones. */
function keepFirstHeight(set: (update: (previous: number | undefined) => number | undefined) => void) {
  return (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = event.nativeEvent.layout.height;
    set((previous) => previous ?? height);
  };
}

/**
 * The ring around the badge: a peach track, and the coral fill sweeping round
 * it clockwise from the top with the count. Drawn from the fill's value, so it
 * moves with the figure under it frame for frame.
 */
function FillRing({ fill }: { fill: number }) {
  const theme = useAppTheme();
  const centre = RING_SIZE / 2;
  return (
    <Svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} style={{ position: 'absolute' }}>
      <Circle cx={centre} cy={centre} r={RING_RADIUS} stroke={theme.colors.selectedStrong} strokeWidth={RING_STROKE} fill="none" />
      <Circle
        cx={centre}
        cy={centre}
        r={RING_RADIUS}
        stroke={theme.colors.primaryFill}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
        strokeDashoffset={RING_LENGTH * (1 - Math.min(1, Math.max(0, fill)))}
        transform={`rotate(-90 ${centre} ${centre})`}
      />
    </Svg>
  );
}

function WelcomeCard({
  amount,
  phase,
  fill,
  count,
  message,
  inviteLine = null,
  onClaim,
  onFigureMeasured,
}: {
  amount: number;
  phase: Phase;
  fill: number;
  count: number;
  message: string | null;
  /** What became of the invite the sign-up claimed, if it claimed one. */
  inviteLine?: { tone: 'success' | 'info'; text: string } | null;
  onClaim: () => void;
  onFigureMeasured: (origin: ClaimOrigin | null) => void;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const progress = useSpringState(entered);
  const scale = progress ? progress.interpolate({ inputRange: [0, 1], outputRange: [ENTRY_SCALE, 1] }) : 1;
  const claimed = phase === 'claimed';
  const landed = claimed && count >= amount;
  const figureRef = useRef<View | null>(null);
  // The title and the note keep the height they first had: the shorter
  // claimed words must not shrink the card and move the figure under the burst.
  const [titleHeight, setTitleHeight] = useState<number | undefined>(undefined);
  const [noteHeight, setNoteHeight] = useState<number | undefined>(undefined);
  // The badge's and the figure's pop as the count lands.
  const [pop] = useState(() => new Animated.Value(1, { useNativeDriver: true }));

  useEffect(() => {
    if (!landed || reducedMotion) return;
    const settle = Animated.sequence([
      Animated.timing(pop, { toValue: POP_SCALE, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(pop, { toValue: 1, duration: 460, easing: POP_EASE, useNativeDriver: true }),
    ]);
    settle.start();
    return () => settle.stop();
  }, [landed, pop, reducedMotion]);

  // Where the figure is, for the burst: measured as Claim is tapped, before
  // anything moves. The burst starts a little above its centre.
  const measureFigure = () => {
    const figure = figureRef.current;
    if (!figure?.measureInWindow) {
      onFigureMeasured(null);
      return;
    }
    figure.measureInWindow((x, y, width, height) => onFigureMeasured({ x: x + width / 2, y: y + height * 0.4 }));
  };

  const title = landed ? 'Credits added!' : claimed ? 'Adding your credits' : 'Claim your welcome credits';
  const note = landed
    ? 'They’re in your balance now. Go make something amazing.'
    : claimed
      ? 'Counting them into your balance…'
      : 'A welcome gift for creating images, video and motion. It can only be used for creating media, not to buy recipes or resources.';

  return (
    <MotionView
      style={{
        width: '100%',
        maxWidth: CARD_MAX_WIDTH,
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        backgroundColor: theme.colors.surfaceInset,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingTop: appTheme.spacing.section,
        paddingHorizontal: appTheme.spacing.panel,
        paddingBottom: appTheme.spacing.panel,
        alignItems: 'center',
        gap: appTheme.spacing.screen,
        overflow: 'hidden',
        opacity: progress ?? 1,
        transform: [{ scale }],
      }}
    >
      {/* A warm wash behind the badge, fading into the white below. */}
      <LinearGradient
        pointerEvents="none"
        colors={[theme.colors.selected, theme.colors.surfaceInset]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: RING_SIZE + appTheme.spacing.section + FIGURE_LINE }}
      />

      <View style={{ width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' }}>
        <FillRing fill={claimed ? fill : 0} />
        <Animated.View style={{ transform: [{ scale: pop }] }}>
          <LinearGradient
            colors={[theme.colors.navigationCreateTop, theme.colors.navigationCreateBottom]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ width: BADGE_SIZE, height: BADGE_SIZE, borderRadius: appTheme.radii.pill, alignItems: 'center', justifyContent: 'center', boxShadow: theme.shadow.navigationCreate.boxShadow }}
          >
            <Sparkles size={appTheme.icon.hero} color={theme.colors.onPrimary} />
          </LinearGradient>
        </Animated.View>
      </View>

      <View
        ref={figureRef}
        collapsable={false}
        accessible
        accessibilityLabel={`${claimed ? count : amount} creation credits`}
        style={{ alignItems: 'center' }}
      >
        <Animated.View style={{ transform: [{ scale: pop }] }}>
          <AppText
            variant="display"
            color={claimed ? 'primary' : 'text'}
            style={{ fontSize: FIGURE_SIZE, lineHeight: FIGURE_LINE, textAlign: 'center', fontVariant: ['tabular-nums'] }}
          >
            {claimed ? `+${count}` : amount}
          </AppText>
        </Animated.View>
        <AppText variant="label" color="muted" style={{ textAlign: 'center', letterSpacing: 1.2, textTransform: 'uppercase' }}>
          creation credits
        </AppText>
      </View>

      <View onLayout={keepFirstHeight(setTitleHeight)} style={{ justifyContent: 'center', minHeight: titleHeight }}>
        <AppText heading variant="sectionTitle" style={{ textAlign: 'center' }}>{title}</AppText>
      </View>

      <View onLayout={keepFirstHeight(setNoteHeight)} style={{ justifyContent: 'center', minHeight: noteHeight }}>
        <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>{note}</AppText>
      </View>

      {inviteLine ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: appTheme.spacing.compact }}>
          {inviteLine.tone === 'success' ? <Check size={appTheme.icon.compact} color={theme.colors.success} /> : null}
          <AppText variant="caption" color={inviteLine.tone === 'success' ? 'success' : 'muted'} style={{ flexShrink: 1, textAlign: 'center' }}>
            {inviteLine.text}
          </AppText>
        </View>
      ) : null}

      {message ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.danger, textAlign: 'center' }}>{message}</Text>
      ) : null}

      {claimed ? (
        <View
          accessibilityRole="text"
          style={{ alignSelf: 'stretch', minHeight: MIN_HIT_TARGET_PT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact }}
        >
          <Check size={appTheme.icon.compact} color={theme.colors.success} />
          <AppText variant="label" color="success">{landed ? 'Added to your balance' : 'Adding to your balance'}</AppText>
        </View>
      ) : phase === 'refused' ? null : (
        <PrimaryButton
          label={phase === 'failed' ? 'Try again' : 'Claim'}
          loadingLabel="Claiming…"
          loading={phase === 'claiming'}
          style={{ alignSelf: 'stretch' }}
          onPress={() => {
            measureFigure();
            onClaim();
          }}
        />
      )}
    </MotionView>
  );
}
