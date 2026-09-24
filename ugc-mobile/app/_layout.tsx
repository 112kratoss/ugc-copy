import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, useFonts } from '@expo-google-fonts/bricolage-grotesque';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider, focusManager, useQueryClient } from '@tanstack/react-query';
import { requireOptionalNativeModule } from 'expo';
import Constants from 'expo-constants';
import { AppMetricsRoot } from 'expo-observe';
import { Stack, router, usePathname } from 'expo-router';
import { LucideProvider } from 'lucide-react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import 'react-native-reanimated';
import { AppState, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActionSheetHost } from '@/components/action-sheet';
import { DialogHost } from '@/components/dialog';
import { OnboardingServerSync } from '@/components/onboarding-server-sync';
import { MediaZoomFlightLayer } from '@/components/media-zoom';
import { ZoomPostChrome } from '@/components/zoom-post-chrome';
import { OverlayHost } from '@/components/overlay-host';
import { SignOutOverlay } from '@/components/sign-out-overlay';
import { CriticalUpdateSheet } from '@/components/critical-update-sheet';
import { useOtaUpdateGate } from '@/lib/use-ota-update-gate';
import { setSessionMergedHandler, setSessionRejectedHandler, setUpgradeRequiredHandler } from '@/lib/api-client';
import { AuthProvider, useAuth } from '@/lib/auth';
import { notificationBadgeQueryKey } from '@/lib/notification-badge';
import { isAppVersionBelowMinimum } from '@/lib/app-compatibility';
import { readAppVersionParts } from '@/lib/app-version-label';
import { setNativeImageCapabilities, type NativeImageCapabilities } from '@/lib/media-blur';
import { subscribeToAppForeground } from '@/lib/app-foreground';
import { setMediaDiagnosticsReporter } from '@/lib/media-diagnostics';
import { readPlaybackDevice, readPlaybackNetwork } from '@/lib/playback-device';
import { setPlaybackMetricsReporter } from '@/lib/playback-metrics';
import { hasAppleZoomParam } from '@/lib/apple-zoom';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useReducedMotion } from '@/lib/motion';
import { navigateToNotificationDeepLink, subscribeToNotificationResponses, subscribeToNotificationsReceived } from '@/lib/notifications';
import { OnboardingProvider, useOnboarding } from '@/lib/onboarding';
import { installMediaQueryRetention, pruneInactiveMediaQueries } from '@/lib/media-query-retention';
import { restorePersistedHomeFeed } from '@/lib/persisted-home-feed';
import { reportStartupMilestone } from '@/lib/startup-interactive';
import { STARTUP_VERSION_CHECK_FALLBACK_MS, type StartupVersionCheckStatus } from '@/lib/startup-readiness';
import { hydrateAppearancePreference, useResolvedColorScheme } from '@/lib/appearance';
import { useNavigationBarSurface } from '@/lib/system-bars';
import { appTheme, mediaColors, themes, type AppTheme } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';

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

// What this binary's expo-image can do, read before any picture is drawn: an
// Android build whose blur still goes through RenderScript is never asked to
// blur (lib/media-blur.ts).
setNativeImageCapabilities(requireOptionalNativeModule<NativeImageCapabilities>('ExpoImage'));

/** A post's rail, caption and controls, drawn in the window it grows in (`ZoomStill.post`). */
function renderZoomPost(post: ImmersivePreviewItem) {
  return <ZoomPostChrome post={post} />;
}

/**
 * The navigator's own animation for the reel screen. Android: none, the zoom is
 * its whole transition (see the viewer screen below). iOS: the short fade a reel
 * arrives and leaves under — except when it is pushed under a tile's picture
 * that already fills the screen. A fade there plays unseen beneath the picture
 * and only holds back the reel's reveal until it ends (the reel may not be
 * uncovered while it is still translucent), which kept the rail and caption off
 * an iPhone 16e's screen some 200 ms after everything was ready. Read when the
 * reel is pushed; the viewer puts the fade back for the ways it leaves.
 */
function viewerAnimation(params: object | undefined): 'none' | 'fade' | 'default' {
  if (Platform.OS === 'android') return 'none';
  // iOS 18: a reel opened from a tile arrives by UIKit's own zoom transition
  // (lib/apple-zoom.ts), which react-native-screens leaves to UIKit only under
  // its default animation — any other is an animator of its own, and the pop
  // would run it instead of the zoom back into the tile. A reel opened any
  // other way — a deep link, a notification, a device before iOS 18 — fades.
  return hasAppleZoomParam(params) ? 'default' : 'fade';
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 45,
    },
  },
});

installMediaQueryRetention(queryClient);
AppState.addEventListener('memoryWarning', () => pruneInactiveMediaQueries(queryClient, true));

// The For You page the last launch saved goes back into the cache while the
// rest of the app starts, so a returning launch draws posts rather than
// skeletons once the session is restored. See lib/persisted-home-feed.
void restorePersistedHomeFeed(queryClient);

// Progress indicators: "perform automatic updates periodically — don't make
// people manually refresh". React Query's focus refetch is inert on native
// until the app's foreground state is wired to it; with the 45s staleTime
// above, returning to the app refreshes what has actually gone stale and
// nothing else.
AppState.addEventListener('change', (state) => {
  focusManager.setFocused(state === 'active');
});

// The saved Settings → Appearance choice is read while the splash is still up
// (the layout holds the splash on it beside the fonts), so an app set to Light
// on a dark phone never shows a dark first frame.
const appearanceHydration = hydrateAppearancePreference();

function navigationThemeFor(theme: AppTheme) {
  const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.panel,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.danger,
    },
  };
}

function RootLayout() {
  return <RootLayoutNav />;
}

export default AppMetricsRoot.wrap(RootLayout);

function RootLayoutNav() {
  const reducedMotion = useReducedMotion();
  const [fontsLoaded, fontError] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  const [appearanceReady, setAppearanceReady] = useState(false);
  const scheme = useResolvedColorScheme();
  const theme = themes[scheme];
  // Android's navigation bar icons follow the app's scheme; a dark surface
  // above (the reel) takes over while it is in front.
  useNavigationBarSurface(scheme);

  useEffect(() => {
    let active = true;
    void appearanceHydration.then(() => {
      if (active) setAppearanceReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if ((!fontsLoaded && !fontError) || !appearanceReady) return;
    void SplashScreen.hideAsync().catch(() => undefined);
  }, [appearanceReady, fontError, fontsLoaded]);

  useEffect(() => {
    const fallback = setTimeout(() => {
      void SplashScreen.hideAsync().catch(() => undefined);
    }, FONT_SPLASH_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, []);

  return (
    <ThemeScope scheme={scheme}>
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
          <SessionMergedCoordinator />
          <SessionRejectedCoordinator />
          <OtaUpdateCoordinator />
          <MediaDiagnosticsCoordinator />
          <SafeAreaProvider>
            <ThemeProvider value={navigationThemeFor(theme)}>
              <GestureHandlerRootView style={{ flex: 1 }}>
              <View style={{ flex: 1, backgroundColor: theme.colors.app }}>
                {/* Light icons on the dark scheme, dark icons on paper. The reel
                    mounts its own light-content bar above this one while it is
                    open, because it stays dark in both schemes. */}
                <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
                {/* Above the navigator so a hosted surface can cover the tab
                    bar, and inside the app's own window so keyboard avoidance
                    reaches it — which a React Native Modal cannot offer on
                    Android. */}
                <OverlayHost>
                <ActionSheetHost />
                <DialogHost />
                <SignOutOverlay />
                <Stack
                screenOptions={{
                  animation: reducedMotion ? 'none' : 'default',
                  gestureEnabled: true,
                  headerBackButtonDisplayMode: 'minimal',
                  headerShadowVisible: false,
                  headerStyle: { backgroundColor: theme.colors.background },
                  headerTintColor: theme.colors.text,
                  headerTitleStyle: { fontWeight: '700' },
                  contentStyle: { backgroundColor: theme.colors.background },
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
                    contentStyle: { backgroundColor: theme.colors.background },
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
                    contentStyle: { backgroundColor: theme.colors.background },
                  }}
                />
                <Stack.Screen
                  name="post/[id]"
                  options={{
                    headerShown: false,
                    animation: reducedMotion ? 'none' : 'simple_push',
                    contentStyle: { backgroundColor: theme.colors.app },
                  }}
                />
                {/* The reel opens by growing out of the tapped tile and shrinks back
                    into it. Android: the layer above the navigator flies the
                    picture (`components/media-zoom.tsx`), and the reel is a
                    transparent modal so the screen beneath stays attached and
                    drawn — the reel's own window shrinks back over it live, and
                    the navigator animates nothing. iOS: a plain pushed card, and
                    UIKit's own zoom transition does the growing and shrinking
                    (lib/apple-zoom.ts) — interactively, with the feed drawn
                    beneath the whole way. A card, not a modal: a modal here would
                    turn every screen pushed after it into a sheet
                    (native-stack's `getModalRouteKeys`) and lose the edge-swipe
                    back. Opaque, so the zoom never shows the system background
                    through a reel still building its first slide. */}
                <Stack.Screen
                  name="viewer"
                  options={({ route }) => ({
                    headerShown: false,
                    presentation: Platform.OS === 'android' ? 'transparentModal' : 'card',
                    contentStyle: { backgroundColor: Platform.OS === 'android' ? 'transparent' : mediaColors.mediaGround },
                    animation: reducedMotion ? 'none' : viewerAnimation(route.params),
                    animationDuration: 250,
                  })}
                />
                {/* Keep the library and its card feed opaque while navigating. A
                    fade composites two dense media surfaces and briefly makes
                    cards from the grid look stacked over feed cards. */}
                <Stack.Screen name="profile-media-feed" options={{ headerShown: false, animation: reducedMotion ? 'none' : 'simple_push' }} />
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
                {/* Above every screen: the flight a tapped tile's picture makes
                    to the full screen and back, which no screen change can
                    interrupt. Nothing is rendered unless a post is opening or
                    closing. An open draws the post whole — rail, caption and
                    controls — from its first frame. */}
                <ThemeScope scheme="dark">
                  <MediaZoomFlightLayer renderPost={renderZoomPost} />
                </ThemeScope>
              </View>
              </GestureHandlerRootView>
            </ThemeProvider>
          </SafeAreaProvider>
        </OnboardingProvider>
      </AuthProvider>
      </LucideProvider>
    </QueryClientProvider>
    </ThemeScope>
  );
}

function StartupCoordinator() {
  const theme = useAppTheme();
  const { api, isLoading, user } = useAuth();
  const { isHydrated, state, storageAvailable } = useOnboarding();
  const pathname = usePathname();
  const [versionCheckStatus, setVersionCheckStatus] =
    useState<StartupVersionCheckStatus>('idle');

  useEffect(() => {
    if (isHydrated && !isLoading) reportStartupMilestone({ milestone: 'shell-ready', pathname });
  }, [isHydrated, isLoading, pathname]);

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
    return <View pointerEvents="none" style={{ position: 'absolute', inset: 0, zIndex: 100, backgroundColor: theme.colors.background }} />;
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

function MediaDiagnosticsCoordinator() {
  // Sends a sampled trace of media stalls and failures to the backend (see
  // lib/media-diagnostics), so a blank-media incident on any phone leaves
  // evidence behind even when nobody copies the report from Settings.
  const { api } = useAuth();

  useEffect(() => setMediaDiagnosticsReporter({
    send: (report) => api.reportMediaDiagnostics(report),
    app: () => {
      const { version, build, update } = readAppVersionParts();
      // The group's first 8 characters, as Settings shows it: enough to find the
      // update in `eas update:list`, and within the backend's field bound.
      return { version, build, update: update?.slice(0, 8) ?? null };
    },
  }), [api]);

  // Sends each session's aggregated video start-up and stall numbers (see
  // lib/playback-metrics): the fleet-wide reading the delivery plan's
  // remaining decisions are gated on.
  useEffect(() => setPlaybackMetricsReporter({
    send: (report) => api.reportPlaybackMetrics(report),
    app: () => {
      const { version, build, update } = readAppVersionParts();
      return { version, build, update: update?.slice(0, 8) ?? null };
    },
    device: readPlaybackDevice,
    network: readPlaybackNetwork,
    subscribeToBackground: (onBackground) => subscribeToAppForeground((foreground) => {
      if (!foreground) onBackground();
    }),
  }), [api]);

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

function SessionMergedCoordinator() {
  // Moves the device off a guest session the server has retired (409
  // SESSION_MERGED). Registered here rather than in the api-client so that lib
  // keeps its independence from the auth provider and the router.
  const { abandonMergedGuestSession } = useAuth();
  const abandonRef = useRef(abandonMergedGuestSession);

  useEffect(() => {
    abandonRef.current = abandonMergedGuestSession;
  }, [abandonMergedGuestSession]);

  useEffect(() => {
    setSessionMergedHandler(() => {
      void abandonRef.current().catch((error) => {
        console.warn('Could not abandon the merged guest session', error);
      });
    });
    return () => setSessionMergedHandler(null);
  }, []);

  return null;
}

function SessionRejectedCoordinator() {
  // Checks a session the server refused (401), usually one that ended on
  // another device, instead of leaving every screen on an error until its token
  // expires. Registered here for the same reason as SessionMergedCoordinator.
  const { recoverRejectedSession } = useAuth();
  const recoverRef = useRef(recoverRejectedSession);

  useEffect(() => {
    recoverRef.current = recoverRejectedSession;
  }, [recoverRejectedSession]);

  useEffect(() => {
    setSessionRejectedHandler(() => {
      void recoverRef.current().catch((error) => {
        console.warn('Could not recover the refused session', error);
      });
    });
    return () => setSessionRejectedHandler(null);
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
