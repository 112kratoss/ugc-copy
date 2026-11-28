import { Stack } from 'expo-router';
import { View } from 'react-native';

import { leaveForHome } from '@/components/app-error-boundary';
import { AppText, PrimaryButton } from '@/components/ui';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * A link the app has no screen for: an old link, a mistyped one, a page that has moved. Drawn as
 * the app's error page is (`components/app-error-boundary.tsx`): what happened, that nothing else
 * is lost, and the way to Home, with the header's back arrow for the page the link was opened
 * over. It used to read "404 · That screen is not here" with "Go to Create", and was also what
 * Android showed for a moment after Google sign-in, which `app/+native-intent.tsx` now keeps from
 * reaching any screen (owner's video, 2026-11-28).
 */
export default function NotFoundScreen() {
  const theme = useAppTheme();
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          gap: appTheme.spacing.gap,
          padding: appTheme.spacing.screen,
          backgroundColor: theme.colors.background,
        }}
      >
        <AppText variant="sectionTitle" accessibilityRole="header">This page isn’t available</AppText>
        <AppText variant="bodySm" color="muted">
          The link may be old, or what it opened has moved or been removed. Everything else is where you left it.
        </AppText>
        <PrimaryButton label="Go to Home" onPress={leaveForHome} />
      </View>
    </>
  );
}
