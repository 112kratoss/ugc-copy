import { router } from 'expo-router';
import { ArrowRight, Gift, Sparkles } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { useAuth } from '@/lib/auth';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion } from '@/lib/motion';
import { isOnboardingActionable } from '@/lib/onboarding-destination';
import { appTheme } from '@/lib/theme';
import { useOnboardingDestination } from '@/lib/use-onboarding-destination';
import { AppText, Card, Kicker } from './ui';

export function OnboardingResumeCard({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const destination = useOnboardingDestination();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });

  // `none` means nothing is outstanding; `pending` means we do not know yet.
  // Both render nothing, but for different reasons — guessing during `pending`
  // is what made the card pop in late and shift the feed under a thumb.
  if (!isOnboardingActionable(destination)) return null;

  const title = destination === 'reward'
    ? 'Your Creator Pack is waiting'
    : destination === 'identity'
      ? user ? 'Finish your creator setup' : 'Claim your creator name and credits'
      : 'See the new creator setup';
  // Both call sites render this card compact, where the body gets a single
  // line. These are written to fit that line: the previous copy ran to 68
  // characters and was cut mid-sentence on every device — and Android drew the
  // overflowing second line rather than ellipsizing it, so it read as broken
  // rather than merely shortened.
  const body = destination === 'reward'
    ? 'Claim your welcome credits.'
    : destination === 'identity'
      ? 'Pick the name people will see.'
      : 'Choose a goal to open a workspace.';

  const iconSize = compact ? 34 : 48;
  const glyphSize = compact ? 17 : 23;

  /**
   * Open the flow.
   *
   * Deliberately writes no status. The previous version marked the run
   * `in_progress` on every tap, which silently demoted an already-completed
   * onboarding and was half of why this card kept coming back.
   */
  const open = () => {
    haptic.light();
    router.push('/onboarding' as never);
  };

  return (
    <MotionView style={motion.animatedStyle}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      onPress={open}
      onPressIn={motion.onPressIn}
      onPressOut={motion.onPressOut}
    >
      <Card padding={compact ? 'sm' : 'md'} style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 11 : 14 }}>
        <View style={{ width: iconSize, height: iconSize, borderRadius: iconSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.surfaceStrong }}>
          {destination === 'reward' ? <Gift size={glyphSize} color={appTheme.colors.text} /> : <Sparkles size={glyphSize} color={appTheme.colors.text} />}
        </View>
        <View style={{ flex: 1, gap: compact ? 2 : 4 }}>
          {compact ? null : <Kicker>Creator setup</Kicker>}
          <AppText variant={compact ? 'button' : 'cardTitle'}>{title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={compact ? 1 : undefined} ellipsizeMode="tail">{body}</AppText>
        </View>
        <ArrowRight size={compact ? 18 : 20} color={appTheme.colors.primary} />
      </Card>
    </Pressable>
    </MotionView>
  );
}
