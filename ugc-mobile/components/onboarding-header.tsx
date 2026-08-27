import { Pressable, View } from 'react-native';

import { AppText, BrandLockup } from '@/components/ui';
import { appTheme } from '@/lib/theme';

/**
 * One header for every step of the flow.
 *
 * Before S3 the welcome screen drew its own lockup (a 29pt glyph beside 25pt
 * text) and the goal screen drew another (26 beside 23), and only the second
 * one carried a way out — so the first screen a new install shows had no way
 * past it, and the flow introduced the product's name at two sizes in two taps.
 * Onboarding: "design a flow that's fast, fun, and optional."
 */
export function OnboardingHeader({
  size = 'compact',
  onSkip,
}: {
  size?: 'compact' | 'hero';
  onSkip?: () => void;
}) {
  // Three columns rather than a control laid over a centred lockup: the
  // wordmark is a display-face string that grows with Dynamic Type, so an
  // absolutely-placed Skip would eventually sit on top of it. The leading
  // spacer keeps the name optically centred against the trailing control.
  const gutter = onSkip ? appTheme.touch.default : 0;

  return (
    <View
      style={{
        minHeight: appTheme.touch.default,
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.compact,
      }}
    >
      <View style={{ width: gutter }} />
      <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', minWidth: 0 }}>
        <BrandLockup size={size} />
      </View>
      {onSkip ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip onboarding and explore as guest"
          onPress={onSkip}
          style={({ pressed }) => ({
            minWidth: gutter,
            minHeight: appTheme.touch.default,
            alignItems: 'flex-end',
            justifyContent: 'center',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <AppText selectable={false} variant="label" color="textSecondary">Skip</AppText>
        </Pressable>
      ) : (
        <View style={{ width: gutter }} />
      )}
    </View>
  );
}
