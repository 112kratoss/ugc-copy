import { router } from 'expo-router';
import { ArrowRight, Gift, Sparkles } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion } from '@/lib/motion';
import { isOnboardingActionable } from '@/lib/onboarding-destination';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useOnboardingDestination } from '@/lib/use-onboarding-destination';
import { AppText, Card } from './ui';

export function OnboardingResumeCard() {
  const theme = useAppTheme();
  const destination = useOnboardingDestination();
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedCard });

  // `none` means nothing is outstanding; `pending` means we do not know yet.
  // Both render nothing, but for different reasons — guessing during `pending`
  // is what made the card pop in late and shift the feed under a thumb.
  if (!isOnboardingActionable(destination)) return null;

  // The identity step is only chosen for a signed-in user, so one title serves.
  const title = destination === 'reward'
    ? 'Your welcome credits are waiting'
    : destination === 'identity'
      ? 'Finish your creator setup'
      : 'See the new creator setup';
  // The body gets a single line. These are written to fit it: the previous
  // copy ran to 68 characters and was cut mid-sentence on every device — and
  // Android drew the overflowing second line rather than ellipsizing it, so it
  // read as broken rather than merely shortened.
  const body = destination === 'reward'
    ? 'Claim your welcome credits.'
    : destination === 'identity'
      ? 'Pick the name people will see.'
      : 'Choose a goal to open a workspace.';

  const iconSize = 34;
  const glyphSize = 17;

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
      <Card padding="sm" style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <View style={{ width: iconSize, height: iconSize, borderRadius: iconSize / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
          {destination === 'reward' ? <Gift size={glyphSize} color={theme.colors.text} /> : <Sparkles size={glyphSize} color={theme.colors.text} />}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="button">{title}</AppText>
          <AppText variant="caption" color="muted" numberOfLines={1} ellipsizeMode="tail">{body}</AppText>
        </View>
        <ArrowRight size={18} color={theme.colors.primary} />
      </Card>
    </Pressable>
    </MotionView>
  );
}
