import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, useFonts } from '@expo-google-fonts/bricolage-grotesque';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider, focusManager, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { AppMetricsRoot } from 'expo-observe';
import { Stack, router, usePathname } from 'expo-router';
import { LucideProvider } from 'lucide-react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import 'react-native-reanimated';
import { AppState, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-url-polyfill/auto';

import { ActionSheetHost } from '@/components/action-sheet';
import { DialogHost } from '@/components/dialog';
import { OnboardingServerSync } from '@/components/onboarding-server-sync';
import { OverlayHost } from '@/components/overlay-host';
import { CriticalUpdateSheet } from '@/components/critical-update-sheet';
import { useOtaUpdateGate } from '@/lib/use-ota-update-gate';
import { setUpgradeRequiredHandler } from '@/lib/api-client';
import { AuthProvider, useAuth } from '@/lib/auth';
import { notificationBadgeQueryKey } from '@/lib/notification-badge';
import { isAppVersionBelowMinimum } from '@/lib/app-compatibility';
import { useReducedMotion } from '@/lib/motion';
import { navigateToNotificationDeepLink, subscribeToNotificationResponses, subscribeToNotificationsReceived } from '@/lib/notifications';
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

// The display face arrives from the bundle in a few frames; holding the splash
// until then means the first screen never swaps fonts in front of the user.
// FONT_SPLASH_FALLBACK_MS guarantees the splash can never hang on it.
const FONT_SPLASH_FALLBACK_MS = 1200;
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 45,
    },
  },
});

// Progress indicators: "perform automatic updates periodically — don't make
// people manually refresh". React Query's focus refetch is inert on native
// until the app's foreground state is wired to it; with the 45s staleTime
// above, returning to the app refreshes what has actually gone stale and
// nothing else.
AppState.addEventListener('change', (state) => {
  focusManager.setFocused(state === 'active');
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
  const [fontsLoaded, fontError] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });

  useEffect(() => {
    if (!fontsLoaded && !fontError) return;
    void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontError, fontsLoaded]);

  useEffect(() => {
    const fallback = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => undefined);
    }, FONT_SPLASH_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* One stroke weight for every interface icon in the app (HIG Icons).
          Call sites choose a size; the weight is never passed per-icon. */}
      <LucideProvider strokeWidth={appTheme.icon.stroke}>
      <AuthProvider>
        <OnboardingProvider>
          <NotificationResponseCoordinator />
          <OnboardingServerSync />
          <StartupCoordinator />
          <UpgradeRequiredCoordinator />
          <OtaUpdateCoordinator />
          <SafeAreaProvider>
            <ThemeProvider value={navigationTheme}>
              <GestureHandlerRootView style={{ flex: 1 }}>
              <View style={{ flex: 1, backgroundColor: appTheme.colors.app }}>
                <StatusBar style="light" />
                {/* Above the navigator so a hosted surface can cover the tab
                    bar, and inside the app's own window so keyboard avoidance
                    reaches it — which a React Native Modal cannot offer on
                    Android. */}
                <OverlayHost>
                <ActionSheetHost />
                <DialogHost />
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
                    title: 'Sign In',
                    presentation: 'modal',
                    animation: reducedMotion ? 'none' : 'fade_from_bottom',
                    contentStyle: { backgroundColor: appTheme.colors.background },
                  }}
                />
                {/* Same iOS 26 full-screen back pan as `post/new` below, and
                    the same static off — here because the editor holds unsaved
                    prompt/reference edits, and a native pop completes before
                    the route's close guard is ever consulted. The route itself
                    withdraws the remaining edge swipe while the draft is
                    dirty. */}
                <Stack.Screen name="create/[tool]" options={{ headerShown: false, fullScreenGestureEnabled: false, animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/index" options={{ title: 'Templates', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="templates/[slug]" options={{ title: 'Template', animation: reducedMotion ? 'none' : 'simple_push' }} />
                <Stack.Screen name="template-runs/[runId]" options={{ title: 'Template Run', animation: reducedMotion ? 'none' : 'simple_push' }} />
                {/* Declared a push while wearing a Close button — which reads
                    as a contradiction until you look at the other two creation
                    surfaces. The create tab, `create/[tool]` and this composer
                    are all full-screen, self-contained, and closed rather than
                    backed out of, and the create tab cannot become a modal
                    route because it is a tab (divergence DV5/DV7). Presenting
                    one of the three as a modal would split the family that the
                    same menu opens. What Modality actually asks for — an
                    obvious way out — each of them has. */}
                <Stack.Screen
                  name="post/new"
                  options={{
                    headerShown: false,
                    /* iOS 26 made the navigator's back gesture a full-screen pan
                       (`fullScreenGestureEnabled` defaults to true from that OS),
                       and a native recognizer always outranks the JS responder
                       the composer's media reorder runs on — one pan frame in,
                       the drag was terminated and the screen popped. Off here so
                       a card can be dragged right; the edge swipe stays live, so
                       the screen keeps the way out Modality asks for. Any other
                       screen that grows a horizontal drag needs the same line. */
                    fullScreenGestureEnabled: false,
                    presentation: 'card',
                    animation: reducedMotion ? 'none' : 'simple_push',
                    contentStyle: { backgroundColor: appTheme.colors.background },
                  }}
                />
                <Stack.Screen
                  name="post/[id]"
                  options={{
                    headerShown: false,
                    animation: reducedMotion ? 'none' : 'simple_push',
                    contentStyle: { backgroundColor: appTheme.colors.app },
                  }}
                />
                {/* A plain native fade: the reel, its rail and its caption arrive in
                    the same frame, the way a tapped reel opens elsewhere. A hero
                    zoom out of the tile was tried (2026-08-23) and read as the media
                    arriving before its controls, so it was taken out. */}
                <Stack.Screen name="viewer" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="profile-media-feed" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="showcase" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'fade' }} />
                <Stack.Screen name="creators/[username]" options={{ title: 'Creator' }} />
                <Stack.Screen name="marketplace/[assetId]" options={{ title: 'Unlock' }} />
                <Stack.Screen name="unlock/[unlockId]" options={{ title: 'Your Unlock' }} />
                <Stack.Screen name="edit-profile" options={{ headerShown: false, presentation: 'modal', animation: reducedMotion ? 'none' : 'slide_from_bottom' }} />
                <Stack.Screen name="seller-dashboard" options={{ title: 'Your Sales' }} />
                <Stack.Screen name="unlocks" options={{ title: 'Your Unlocks' }} />
                <Stack.Screen name="invite" options={{ title: 'Invite & Earn' }} />
                <Stack.Screen name="r/[code]" options={{ title: 'Your Invite' }} />
                <Stack.Screen name="settings" options={{ title: 'Settings' }} />
                <Stack.Screen name="delete-account" options={{ title: 'Delete Account' }} />
                <Stack.Screen name="help" options={{ title: 'Help & Support' }} />
                </Stack>
                </OverlayHost>
              </View>
              </GestureHandlerRootView>
            </ThemeProvider>
          </SafeAreaProvider>
        </OnboardingProvider>
      </AuthProvider>
      </LucideProvider>
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

function OtaUpdateCoordinator() {
  // Applies a downloaded OTA update when the policy allows, and owns the one
  // case that is allowed to say so out loud. Everything routine happens with no
  // UI at all — see lib/app-update-policy for why, and lib/app-activity for
  // what stops a reload landing in the middle of someone's work.
  const { applyNow, criticalPromptVisible, dismissPrompt } = useOtaUpdateGate();

  return (
    <CriticalUpdateSheet
      onDismiss={dismissPrompt}
      onRestart={applyNow}
      visible={criticalPromptVisible}
    />
  );
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

  // An alert that arrives while the app is in front no longer always draws a
  // banner (HIG Notifications asks for "discoverable but not distracting"), so
  // the app has to be the one that shows it: the tab badge and the Alerts list
  // refresh the moment it lands rather than on the badge's next poll.
  useEffect(() => subscribeToNotificationsReceived(() => {
    void queryClient.invalidateQueries({ queryKey: notificationBadgeQueryKey(user?.id) });
    void queryClient.invalidateQueries({ queryKey: ['mobile-notifications', user?.id] });
  }), [queryClient, user?.id]);

  return null;
}
