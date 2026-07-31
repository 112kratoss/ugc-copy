import { router } from 'expo-router';
import { ArrowRight, Gift, Sparkles } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useAuth } from '@/lib/auth';
import { useOnboarding } from '@/lib/onboarding';
import { appTheme } from '@/lib/theme';
import type { WelcomeCreditResponse } from '@/lib/types';
import { AppText, Card, Kicker } from './ui';

export function OnboardingResumeCard({ compact = false }: { compact?: boolean }) {
  const { api, user } = useAuth();
  const { state, update } = useOnboarding();
  const [welcome, setWelcome] = useState<WelcomeCreditResponse | null>(null);

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

  const rewardPending = welcome?.status === 'eligible' || welcome?.status === 'unavailable';
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
    const lastStep = rewardPending ? 5 : showOptionalIntro ? 0 : state.lastStep;
    await update({ status: 'in_progress', lastStep });
    router.push((rewardPending ? '/onboarding?resume=identity' : '/onboarding') as never);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={() => void open()}
      style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card accent="primary" padding={compact ? 'sm' : 'md'} style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 11 : 14 }}>
        <View style={{ width: iconSize, height: iconSize, borderRadius: iconSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.selectedStrong }}>
          {rewardPending ? <Gift size={glyphSize} color={appTheme.colors.primary} /> : <Sparkles size={glyphSize} color={appTheme.colors.primary} />}
        </View>
        <View style={{ flex: 1, gap: compact ? 2 : 4 }}>
          {compact ? null : <Kicker color="primary">Creator setup</Kicker>}
          <AppText variant={compact ? 'button' : 'cardTitle'}>{title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={compact ? 1 : undefined}>{body}</AppText>
        </View>
        <ArrowRight size={compact ? 18 : 20} color={appTheme.colors.primary} />
      </Card>
    </Pressable>
  );
}
