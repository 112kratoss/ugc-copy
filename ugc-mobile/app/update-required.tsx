import { Stack } from 'expo-router';
import { Linking, Platform, View } from 'react-native';
import { RefreshCw, Sparkles } from 'lucide-react-native';

import { AppText, Card, Kicker, PrimaryButton, SecondaryButton } from '@/components/ui';
import { env } from '@/lib/env';
import { appTheme } from '@/lib/theme';

export default function UpdateRequiredScreen() {
  const storeUrl = Platform.OS === 'ios' ? env.appStoreUrl : env.playStoreUrl;
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: appTheme.colors.background, padding: 20 }}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <Card accent="primary" padding="lg" style={{ alignItems: 'center', gap: 18, paddingVertical: 34 }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.selectedStrong }}>
          <Sparkles size={32} color={appTheme.colors.primary} />
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Kicker color="primary">Update required</Kicker>
          <AppText heading variant="pageTitle" style={{ textAlign: 'center' }}>A newer Magicbooklet is ready</AppText>
          <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
            Update to keep creating and to use the latest account, credit, and store protections.
          </AppText>
        </View>
        <PrimaryButton label="Open store" onPress={() => void Linking.openURL(storeUrl)} />
        <SecondaryButton label="Check again" onPress={() => void Linking.openURL('magicbooklet://')} accessibilityHint="Returns to the app after updating" />
        <RefreshCw size={18} color={appTheme.colors.faint} accessibilityElementsHidden />
      </Card>
    </View>
  );
}
