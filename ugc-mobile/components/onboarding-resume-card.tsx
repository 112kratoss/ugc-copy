import { router } from 'expo-router';
import { ArrowRight, Gift, Sparkles } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useAuth } from '@/lib/auth';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion } from '@/lib/motion';
import { useOnboarding } from '@/lib/onboarding';
import { isWelcomeRewardPending } from '@/lib/onboarding-state';
import { appTheme } from '@/lib/theme';
import type { WelcomeCreditResponse } from '@/lib/types';
import { AppText, Card, Kicker } from './ui';

export function OnboardingResumeCard({ compact = false }: { compact?: boolean }) {
  const { api, user } = useAuth();
  const { state, update } = useOnboarding();
  const [welcome, setWelcome] = useState<WelcomeCreditResponse | null>(null);
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });

  useEffect(() => {
    if (!user || state.status !== 'completed') return;
    let active = true;
    void api.getWelcomeCredits()
      .then((result) => {
        if (active) setWelcome(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, state.status, user]);

  const rewardPending = isWelcomeRewardPending(welcome?.status);
  const showOptionalIntro = Boolean(user) && state.status === 'not_started';
  const showResume = state.status === 'skipped' || state.status === 'in_progress';
  if (!rewardPending && !showOptionalIntro && !showResume) return null;

  const title = rewardPending
    ? 'Your Creator Pack is waiting'
    : showOptionalIntro
      ? 'See the new creator setup'
      : user
        ? 'Finish your creator setup'
        : 'Claim your creator name and credits';
  const body = rewardPending
    ? 'Finish your welcome reward and jump back into creating.'
    : showOptionalIntro
      ? 'Choose a goal and open a focused starter workspace. You can skip at any time.'
      : 'Resume where you stopped without losing your selected creation goal.';

  const iconSize = compact ? 34 : 48;
  const glyphSize = compact ? 17 : 23;

  const open = async () => {
    haptic.light();
    const lastStep = rewardPending ? 5 : showOptionalIntro ? 0 : state.lastStep;
    await update({ status: 'in_progress', lastStep });
    router.push((rewardPending ? '/onboarding?resume=identity' : '/onboarding') as never);
  };

  return (
    <MotionView style={motion.animatedStyle}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={() => void open()}
      onPressIn={motion.onPressIn}
      onPressOut={motion.onPressOut}
    >
      <Card padding={compact ? 'sm' : 'md'} style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 11 : 14 }}>
        <View style={{ width: iconSize, height: iconSize, borderRadius: iconSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>
          {rewardPending ? <Gift size={glyphSize} color={appTheme.colors.text} /> : <Sparkles size={glyphSize} color={appTheme.colors.text} />}
        </View>
        <View style={{ flex: 1, gap: compact ? 2 : 4 }}>
          {compact ? null : <Kicker>Creator setup</Kicker>}
          <AppText variant={compact ? 'button' : 'cardTitle'}>{title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={compact ? 1 : undefined}>{body}</AppText>
        </View>
        <ArrowRight size={compact ? 18 : 20} color={appTheme.colors.primary} />
      </Card>
    </Pressable>
    </MotionView>
  );
}
