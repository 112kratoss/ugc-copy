import { Image } from 'expo-image';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';

import { AppText, PrimaryButton } from '@/components/ui';
import { OnboardingHeader } from '@/components/onboarding-header';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

import bookletHero from '../assets/images/onboarding-booklet-hero.jpg';

type OnboardingWelcomeProps = {
  availableHeight: number;
  availableWidth: number;
  onGetStarted: () => void;
  onSignIn: () => void;
  /**
   * Onboarding: "design a flow that's fast, fun, and optional". The escape used
   * to appear only on the second screen, so the first thing a new install
   * showed had no way past it.
   */
  onSkip: () => void;
};

export function OnboardingWelcome({
  availableHeight,
  availableWidth,
  onGetStarted,
  onSignIn,
  onSkip,
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
      // Without this React Native falls back to a symmetric `easeInOut`, whose
      // slow start reads as the app hesitating on the very first screen it
      // shows. Decelerating into rest is what makes the hero arrive.
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, reveal]);

  return (
    <View style={{ flex: 1, width: '100%', paddingTop: 10 }}>
      <OnboardingHeader size="hero" onSkip={onSkip} />

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
          opacity: reveal,
          transform: [{
            translateY: reveal.interpolate({
              inputRange: [0, 1],
              outputRange: [9, 0],
            }),
          }],
        }}
      >
        {/* The product's own headline, in the product's own typeface: this and
            the goal screen's title were the two places that hand-rolled a size
            and a weight in the system font, which is the face Branding reserves
            for body copy. `pageTitle` is what every other screen's title uses. */}
        <AppText heading variant="pageTitle" selectable>
          <Text style={{ color: appTheme.colors.primary }}>Create. </Text>
          <Text style={{ color: appTheme.colors.image }}>Share. </Text>
          <Text style={{ color: appTheme.colors.motion }}>Earn.</Text>
        </AppText>

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
