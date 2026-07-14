import { Image } from 'expo-image';
import { Sparkles } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

import { AppText, PrimaryButton } from '@/components/ui';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

import bookletHero from '../assets/images/onboarding-booklet-hero.png';

type OnboardingWelcomeProps = {
  availableHeight: number;
  availableWidth: number;
  onGetStarted: () => void;
  onSignIn: () => void;
};

export function OnboardingWelcome({
  availableHeight,
  availableWidth,
  onGetStarted,
  onSignIn,
}: OnboardingWelcomeProps) {
  const reducedMotion = useReducedMotion();
  const reveal = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const heroHeight = Math.min(
    450,
    Math.max(368, Math.min(availableHeight * 0.56, ((availableWidth + 32) * 915) / 853)),
  );

  useEffect(() => {
    if (reducedMotion) {
      reveal.setValue(1);
      return;
    }

    Animated.timing(reveal, {
      toValue: 1,
      duration: 520,
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, reveal]);

  return (
    <View style={{ flex: 1, width: '100%', paddingTop: 10 }}>
      <View
        accessibilityRole="header"
        accessibilityLabel="Magicbooklet"
        style={{
          minHeight: 40,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 9,
        }}
      >
        <Sparkles size={29} strokeWidth={2.5} color={appTheme.colors.primary} />
        <AppText selectable={false} style={{ fontSize: 25, lineHeight: 31, fontWeight: '800', letterSpacing: -0.35 }}>
          Magicbooklet
        </AppText>
      </View>

      <Animated.View
        style={{
          height: heroHeight,
          marginHorizontal: -16,
          marginTop: 10,
          marginBottom: 14,
          opacity: reveal,
          transform: [
            {
              translateY: reveal.interpolate({
                inputRange: [0, 1],
                outputRange: [14, 0],
              }),
            },
            {
              scale: reveal.interpolate({
                inputRange: [0, 1],
                outputRange: [0.97, 1],
              }),
            },
          ],
        }}
      >
        <Image
          source={bookletHero}
          accessibilityLabel="An open booklet bringing image, video, and motion ideas to life"
          contentFit="contain"
          transition={reducedMotion ? 0 : 240}
          style={{ width: '100%', height: '100%' }}
        />
      </Animated.View>

      <Animated.View
        style={{
          gap: 8,
          marginHorizontal: 16,
          maxWidth: 312,
          opacity: reveal,
          transform: [{
            translateY: reveal.interpolate({
              inputRange: [0, 1],
              outputRange: [9, 0],
            }),
          }],
        }}
      >
        <Text
          accessibilityRole="header"
          selectable
          style={{ fontSize: 32, lineHeight: 38, fontWeight: '900', letterSpacing: -0.65 }}
        >
          <Text style={{ color: appTheme.colors.primary }}>Create. </Text>
          <Text style={{ color: appTheme.colors.image }}>Share. </Text>
          <Text style={{ color: appTheme.colors.motion }}>Earn.</Text>
        </Text>

        <AppText variant="body" color="textSecondary" style={{ maxWidth: 290 }}>
          Turn ideas into polished images, video, and motion—then share what you create.
        </AppText>
      </Animated.View>

      <Animated.View
        style={{
          marginTop: 'auto',
          marginHorizontal: 12,
          paddingTop: 18,
          gap: 3,
          opacity: reveal,
        }}
      >
        <PrimaryButton
          label="Get started"
          size="roomy"
          accessibilityHint="Continue to the Magicbooklet onboarding guide"
          onPress={onGetStarted}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Already have an account? Sign in"
          accessibilityHint="Open the sign in screen"
          onPress={onSignIn}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.default,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <AppText selectable={false} variant="bodySm" color="muted">
            Already have an account?{' '}
            <Text style={{ color: appTheme.colors.primary, fontWeight: '700' }}>Sign in</Text>
          </AppText>
        </Pressable>
      </Animated.View>
    </View>
  );
}
