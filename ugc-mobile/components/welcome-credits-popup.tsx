import { useIsFocused } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Clapperboard, Gift, ImageIcon, Rocket, Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Text, View } from 'react-native';

import { ConfettiBurst } from '@/components/confetti-burst';
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
const BADGE_SIZE = 64;

/**
 * The welcome-credits popup over Home (owner, 2026-11-09): a bright card with a
 * Claim button, a subtle confetti burst once the claim lands, and the figure
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
  const [dismissed, setDismissed] = useState(wasWelcomePopupDismissedThisRun);
  // Latched once offered, so the claim (which turns the answer to "claimed")
  // does not take the card away mid-celebration.
  const [offered, setOffered] = useState<WelcomeCreditResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('offer');
  const [message, setMessage] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const countTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, []);

  const visible = Boolean(offered) && !dismissed;
  const amount = offered?.amount ?? 25;

  const close = () => {
    dismissWelcomePopupThisRun();
    setDismissed(true);
  };

  const countUp = (to: number) => {
    if (reducedMotion) {
      setCount(to);
      haptic.success();
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

  const startCreating = () => {
    close();
    router.push('/(tabs)/creator' as never);
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="none" onRequestClose={close}>
      {visible ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: appTheme.spacing.section, gap: appTheme.spacing.screen }}>
          <View style={{ position: 'absolute', inset: 0, backgroundColor: outerTheme.colors.overlay }} />
          <ThemeScope scheme="light">
            <WelcomeCard
              amount={amount}
              phase={phase}
              count={count}
              message={message}
              onClaim={() => void claim()}
              onStartCreating={startCreating}
            />
            <CloseChip disabled={phase === 'claiming'} onPress={close} />
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

function WelcomeCard({
  amount,
  phase,
  count,
  message,
  onClaim,
  onStartCreating,
}: {
  amount: number;
  phase: Phase;
  count: number;
  message: string | null;
  onClaim: () => void;
  onStartCreating: () => void;
}) {
  const theme = useAppTheme();
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const progress = useSpringState(entered);
  const scale = progress ? progress.interpolate({ inputRange: [0, 1], outputRange: [ENTRY_SCALE, 1] }) : 1;
  const claimed = phase === 'claimed';

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

      <View style={{ alignItems: 'center', gap: appTheme.spacing.compact }}>
        <LinearGradient
          colors={[theme.colors.navigationCreateTop, theme.colors.navigationCreateBottom]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: BADGE_SIZE, height: BADGE_SIZE, borderRadius: appTheme.radii.pill, alignItems: 'center', justifyContent: 'center' }}
        >
          <Gift size={appTheme.icon.hero} color={theme.colors.onPrimary} />
        </LinearGradient>
        <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>
          {claimed ? 'Credits added!' : 'Your welcome gift'}
        </AppText>
        <AppText variant="label" color="primary" style={{ textAlign: 'center' }}>
          {claimed ? 'Go make something amazing' : 'Free credits to start creating'}
        </AppText>
      </View>

      <DashedRule />

      <View style={{ borderRadius: appTheme.radii.md, borderCurve: 'continuous', backgroundColor: theme.colors.surfaceInset, overflow: 'hidden' }}>
        <View
          accessible
          accessibilityLabel={`${claimed ? count : amount} creation credits`}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact, paddingVertical: appTheme.spacing.screen }}
        >
          <Sparkles size={appTheme.icon.feature} color={theme.colors.primaryFill} />
          <AppText variant="display" color="primary" style={{ fontVariant: ['tabular-nums'] }}>
            {claimed ? `+${count}` : amount}
          </AppText>
          <AppText variant="bodySm">creation credits</AppText>
        </View>
        <View style={{ height: 1, backgroundColor: theme.colors.borderSubtle }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact, paddingVertical: appTheme.spacing.gap }}>
          <ImageIcon size={appTheme.icon.sm} color={theme.colors.image} />
          <Clapperboard size={appTheme.icon.sm} color={theme.colors.video} />
          <Rocket size={appTheme.icon.sm} color={theme.colors.motion} />
          <AppText variant="bodySm">Images, video and motion</AppText>
        </View>
      </View>

      <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>
        {claimed ? 'They’re in your balance now.' : 'Yours to create with. They can’t unlock creators’ resources.'}
      </AppText>

      {message ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.danger, textAlign: 'center' }}>{message}</Text>
      ) : null}

      {claimed ? (
        <PrimaryButton label="Start creating" onPress={onStartCreating} />
      ) : (
        <PrimaryButton
          label={phase === 'failed' ? 'Try again' : `Claim ${amount} credits`}
          loading={phase === 'claiming'}
          onPress={onClaim}
        />
      )}

      <ConfettiBurst play={claimed} />
    </MotionView>
  );
}
