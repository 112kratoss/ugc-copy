import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';

import { AuthProvider, useAuth } from '@/lib/auth';
import { navigateToNotificationDeepLink, subscribeToNotificationResponses } from '@/lib/notifications';
import { appTheme } from '@/lib/theme';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 45,
    },
  },
});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <NotificationResponseCoordinator />
        <SafeAreaProvider>
          <ThemeProvider value={DarkTheme}>
            <View style={{ flex: 1, backgroundColor: '#03040d' }}>
              <StatusBar style="light" backgroundColor="#03040d" translucent={false} />
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: appTheme.colors.background },
                  headerTintColor: appTheme.colors.text,
                  contentStyle: { backgroundColor: appTheme.colors.background },
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="auth" options={{ title: 'Sign in' }} />
                <Stack.Screen name="create/[tool]" options={{ title: 'Create' }} />
                <Stack.Screen name="post/new" options={{ title: 'Post' }} />
                <Stack.Screen name="viewer" options={{ headerShown: false }} />
                <Stack.Screen name="profile-media-feed" options={{ headerShown: false }} />
                <Stack.Screen name="showcase" options={{ headerShown: false }} />
                <Stack.Screen name="creators/[username]" options={{ title: 'Creator' }} />
                <Stack.Screen name="marketplace/[assetId]" options={{ title: 'Unlock' }} />
                <Stack.Screen name="edit-profile" options={{ headerShown: false }} />
                <Stack.Screen name="seller-dashboard" options={{ title: 'Seller Dashboard' }} />
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
