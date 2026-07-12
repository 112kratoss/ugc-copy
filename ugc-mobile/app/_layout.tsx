import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';

import { AuthProvider, useAuth } from '@/lib/auth';
import { useReducedMotion } from '@/lib/motion';
import { navigateToNotificationDeepLink, subscribeToNotificationResponses } from '@/lib/notifications';
import { appTheme } from '@/lib/theme';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 45,
    },
  },
});

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: appTheme.colors.primary ?? '#FF7A59',
    background: appTheme.colors.background,
    card: appTheme.colors.panel,
    text: appTheme.colors.text,
    border: appTheme.colors.border,
    notification: appTheme.colors.danger,
  },
};

export default function RootLayout() {
  return <RootLayoutNav />;
}

function RootLayoutNav() {
  const reducedMotion = useReducedMotion();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <NotificationResponseCoordinator />
        <SafeAreaProvider>
          <ThemeProvider value={navigationTheme}>
            <View style={{ flex: 1, backgroundColor: appTheme.colors.app }}>
              <StatusBar style="light" backgroundColor={appTheme.colors.background} translucent={false} />
              <Stack
                screenOptions={{
                  animation: reducedMotion ? 'none' : 'default',
                  gestureEnabled: true,
                  headerBackButtonDisplayMode: 'minimal',
                  headerShadowVisible: false,
                  headerStyle: { backgroundColor: appTheme.colors.background },
                  headerTintColor: appTheme.colors.text,
                  headerTitleStyle: { fontWeight: '700' },
                  contentStyle: { backgroundColor: appTheme.colors.background },
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="auth" options={{ title: 'Sign in', presentation: 'modal', animation: reducedMotion ? 'none' : 'fade_from_bottom' }} />
                <Stack.Screen name="create/[tool]" options={{ title: 'Create', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/index" options={{ title: 'Templates', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/[slug]" options={{ title: 'Template', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="template-runs/[runId]" options={{ title: 'Template creation', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="post/new" options={{ title: 'Post', presentation: 'modal', animation: reducedMotion ? 'none' : 'slide_from_bottom' }} />
                <Stack.Screen name="viewer" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="profile-media-feed" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="showcase" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="creators/[username]" options={{ title: 'Creator' }} />
                <Stack.Screen name="marketplace/[assetId]" options={{ title: 'Unlock' }} />
                <Stack.Screen name="edit-profile" options={{ headerShown: false, presentation: 'modal', animation: reducedMotion ? 'none' : 'slide_from_bottom' }} />
                <Stack.Screen name="seller-dashboard" options={{ title: 'Seller Dashboard' }} />
                <Stack.Screen name="invite" options={{ title: 'Invite & Earn' }} />
                <Stack.Screen name="r/[code]" options={{ title: 'Magicbooklet invite' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen name="help" options={{ title: 'Help & Support' }} />
              </Stack>
            </View>
          </ThemeProvider>
        </SafeAreaProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function NotificationResponseCoordinator() {
  const { api, user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => subscribeToNotificationResponses({
    handleResponse: async ({ notificationId, deepLink }) => {
      if (notificationId) {
        await api.markMobileNotificationsRead([notificationId]).catch((error) => {
          console.error('Failed to mark tapped notification read', error);
        });
      }

      await queryClient.invalidateQueries({ queryKey: ['mobile-notifications', user?.id] });
      if (!navigateToNotificationDeepLink(deepLink)) {
        return navigateToNotificationDeepLink('/studio');
      }

      return true;
    },
  }), [api, queryClient, user?.id]);

  return null;
}
