import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { AppMetricsRoot } from 'expo-observe';
import { Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import 'react-native-reanimated';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';

import { setUpgradeRequiredHandler } from '@/lib/api-client';
import { AuthProvider, useAuth } from '@/lib/auth';
import { isAppVersionBelowMinimum } from '@/lib/app-compatibility';
import { useReducedMotion } from '@/lib/motion';
import { navigateToNotificationDeepLink, subscribeToNotificationResponses } from '@/lib/notifications';
import { OnboardingProvider, useOnboarding } from '@/lib/onboarding';
import { STARTUP_VERSION_CHECK_FALLBACK_MS, type StartupVersionCheckStatus } from '@/lib/startup-readiness';
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

function RootLayout() {
  return <RootLayoutNav />;
}

export default AppMetricsRoot.wrap(RootLayout);

function RootLayoutNav() {
  const reducedMotion = useReducedMotion();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OnboardingProvider>
          <NotificationResponseCoordinator />
          <StartupCoordinator />
          <UpgradeRequiredCoordinator />
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
                <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="update-required" options={{ headerShown: false, gestureEnabled: false, animation: 'none' }} />
                <Stack.Screen
                  name="auth"
                  options={{
                    headerShown: false,
                    title: 'Sign in',
                    presentation: 'modal',
                    animation: reducedMotion ? 'none' : 'fade_from_bottom',
                    contentStyle: { backgroundColor: appTheme.colors.background },
                  }}
                />
                <Stack.Screen name="create/[tool]" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/index" options={{ title: 'Templates', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/[slug]" options={{ title: 'Template', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="template-runs/[runId]" options={{ title: 'Template creation', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen
                  name="post/new"
                  options={{
                    headerShown: false,
                    presentation: 'card',
                    animation: reducedMotion ? 'none' : 'simple_push',
                    contentStyle: { backgroundColor: appTheme.colors.background },
                  }}
                />
                <Stack.Screen name="viewer" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="profile-media-feed" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="showcase" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="creators/[username]" options={{ title: 'Creator' }} />
                <Stack.Screen name="marketplace/[assetId]" options={{ title: 'Unlock' }} />
                <Stack.Screen name="edit-profile" options={{ headerShown: false, presentation: 'modal', animation: reducedMotion ? 'none' : 'slide_from_bottom' }} />
                <Stack.Screen name="seller-dashboard" options={{ title: 'Seller Dashboard' }} />
                <Stack.Screen name="unlocks" options={{ title: 'Your Unlocks' }} />
                <Stack.Screen name="invite" options={{ title: 'Invite & Earn' }} />
                <Stack.Screen name="r/[code]" options={{ title: 'Magicbooklet invite' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen name="delete-account" options={{ title: 'Delete Account' }} />
                <Stack.Screen name="help" options={{ title: 'Help & Support' }} />
                </Stack>
              </View>
            </ThemeProvider>
          </SafeAreaProvider>
        </OnboardingProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function StartupCoordinator() {
  const { api, isLoading, user } = useAuth();
  const { isHydrated, state, storageAvailable } = useOnboarding();
  const pathname = usePathname();
  const [versionCheckStatus, setVersionCheckStatus] =
    useState<StartupVersionCheckStatus>('idle');

  useEffect(() => {
    if (!isHydrated || isLoading) {
      setVersionCheckStatus('idle');
      return;
    }

    let active = true;
    setVersionCheckStatus('pending');
    const fallbackTimer = setTimeout(() => {
      if (!active) return;
      setVersionCheckStatus((current) => current === 'pending' ? 'settled' : current);
    }, STARTUP_VERSION_CHECK_FALLBACK_MS);

    void api.getAppVersion()
      .then((response) => {
        if (!active) return;
        clearTimeout(fallbackTimer);
        const currentVersion = Constants.expoConfig?.version ?? '0.0.0';
        if (isAppVersionBelowMinimum(currentVersion, response.mobileCompatibility.minimumAppVersion)) {
          setVersionCheckStatus('redirecting');
          router.replace('/update-required' as never);
          return;
        }
        setVersionCheckStatus('settled');
      })
      .catch(() => {
        if (!active) return;
        clearTimeout(fallbackTimer);
        setVersionCheckStatus('settled');
      });

    return () => {
      active = false;
      clearTimeout(fallbackTimer);
    };
  }, [api, isHydrated, isLoading]);

  useEffect(() => {
    if (versionCheckStatus === 'redirecting' && pathname === '/update-required') {
      setVersionCheckStatus('settled');
    }
  }, [pathname, versionCheckStatus]);

  useEffect(() => {
    if (
      !isHydrated ||
      isLoading ||
      user ||
      !storageAvailable ||
      versionCheckStatus === 'redirecting'
    ) return;
    if (pathname !== '/') return;
    if (state.status === 'not_started' || state.status === 'in_progress') {
      router.replace('/onboarding' as never);
    }
  }, [isHydrated, isLoading, pathname, state.status, storageAvailable, user, versionCheckStatus]);

  if ((!isHydrated || isLoading) && pathname === '/') {
    return <View pointerEvents="none" style={{ position: 'absolute', inset: 0, zIndex: 100, backgroundColor: appTheme.colors.background }} />;
  }
  return null;
}

function UpgradeRequiredCoordinator() {
  // Routes forced-upgrade (HTTP 426) responses that arrive mid-session to the
  // update screen. Startup version checks are handled by StartupCoordinator.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    setUpgradeRequiredHandler(() => {
      if (pathnameRef.current === '/update-required') return;
      router.replace('/update-required' as never);
    });
    return () => setUpgradeRequiredHandler(null);
  }, []);

  return null;
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
