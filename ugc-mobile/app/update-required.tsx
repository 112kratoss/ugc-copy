import Constants from 'expo-constants';
import { Stack, router } from 'expo-router';
import { useRef, useState } from 'react';
import { AccessibilityInfo, Linking, Platform, View } from 'react-native';
import { RefreshCw, Sparkles } from 'lucide-react-native';

import { AppText, Card, Kicker, PrimaryButton, SecondaryButton } from '@/components/ui';
import { checkAppVersionFloor, type AppVersionFloorCheck } from '@/lib/app-compatibility';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { useAppTheme } from '@/lib/theme-context';

/** What Check again says when it cannot let the person through. */
const CHECK_AGAIN_NOTICE: Record<Exclude<AppVersionFloorCheck, 'met'>, string> = {
  below: 'Still out of date — update from the store.',
  failed: "We couldn't check for updates. Check your connection and try again.",
};

export default function UpdateRequiredScreen() {
  const theme = useAppTheme();
  const { api } = useAuth();
  const storeUrl = Platform.OS === 'ios' ? env.appStoreUrl : env.playStoreUrl;
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A second tap while the first check is out would ask twice.
  const checkInFlightRef = useRef(false);

  // Asks the server, not the router (audit 04-10): opening the app's own URL
  // left the gate for Home without asking again, and Home's first request sent
  // the person straight back, or, inside the 426 handler's quiet window, left
  // Home up with every request failing.
  const checkAgain = async () => {
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    setChecking(true);
    setNotice(null);
    const outcome = await checkAppVersionFloor(api, Constants.expoConfig?.version ?? '0.0.0');
    checkInFlightRef.current = false;
    setChecking(false);
    if (outcome === 'met') {
      router.replace('/' as never);
      return;
    }
    const message = CHECK_AGAIN_NOTICE[outcome];
    setNotice(message);
    AccessibilityInfo.announceForAccessibility(message);
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.colors.background, padding: 20 }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <Card accent="primary" padding="lg" style={{ alignItems: 'center', gap: 18, paddingVertical: 34 }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.selectedStrong }}>
          <Sparkles size={32} color={theme.colors.primary} />
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Kicker color="primary">Update required</Kicker>
          <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>A newer Magicbooklet is ready</AppText>
          <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
            Update to keep creating and to use the latest account, credit, and store protections.
          </AppText>
        </View>
        <PrimaryButton label="Open store" onPress={() => void Linking.openURL(storeUrl)} />
        <SecondaryButton
          label={checking ? 'Checking…' : 'Check again'}
          disabled={checking}
          onPress={() => void checkAgain()}
          accessibilityHint="Checks whether this version can be used again"
        />
        {notice ? (
          <AppText accessibilityLiveRegion="polite" variant="bodySm" style={{ textAlign: 'center' }}>
            {notice}
          </AppText>
        ) : null}
        <RefreshCw size={18} color={theme.colors.faint} accessibilityElementsHidden />
      </Card>
    </View>
  );
}
