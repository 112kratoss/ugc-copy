// The sign-up sheet: what a guest is asked when they reach for something an
// account does (owner, 2026-11-08: Create, Generate, Remix, Like, Follow),
// as TikTok's "Sign up to start creating" does. The generate demo plays inside
// it, so the sheet shows what signing up unlocks. Signing up goes on to the
// creator name and the welcome credits once (`app/onboarding.tsx`, given the
// `returnTo`), and then back to what was tapped.
import { useRoute } from '@react-navigation/native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { WelcomeGenerateDemo } from '@/components/welcome-generate-demo';
import { AppText, IconButton } from '@/components/ui';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { useAuth } from '@/lib/auth';
import { describeProviderSignInError, signInProviderButtons, type AuthNotice } from '@/lib/auth-error-copy';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { onboardingReturnTo } from '@/lib/join-navigation';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';

import googleSignInArtwork from '../assets/images/google-signin-android.png';

/** The sign-in screen's own provider buttons' height and shape (`app/auth.tsx`). */
const BUTTON_HEIGHT = appTheme.touch.roomy;
const GOOGLE_BUTTON_ASPECT = 216 / 48;

export default function JoinScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const { api, user, signInWithApple, signInWithGoogle, isAuthConfigured } = useAuth();
  const { returnTo } = (useRoute().params ?? {}) as { returnTo?: string | string[] };
  const target = onboardingReturnTo(returnTo) ?? '/(tabs)';
  const providers = signInProviderButtons(Platform.OS);
  const [rise] = useState(() => new Animated.Value(0, { useNativeDriver: true }));
  const [appleBusy, setAppleBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const busy = appleBusy || googleBusy;
  const unavailable = !isAuthConfigured || busy;
  const sheetHeight = Math.min(height - insets.top - 24, 760);
  const movedOn = useRef(false);

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reducedMotion ? 0 : 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, rise]);

  useEffect(() => {
    void trackOnboardingEvent(api, 'screen_viewed', { step: 'join' });
  }, [api]);

  const close = useCallback(() => {
    if (movedOn.current) return;
    movedOn.current = true;
    Animated.timing(rise, {
      toValue: 0,
      duration: reducedMotion ? 0 : 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/(tabs)' as never);
    });
  }, [reducedMotion, rise]);

  useHardwareBack(true, close);

  // Signed in, by either button (or already, if the sheet was opened by an
  // account): on to the name and the welcome credits, which come back here.
  const moveOn = useCallback(() => {
    if (movedOn.current) return;
    movedOn.current = true;
    router.replace({ pathname: '/onboarding', params: { returnTo: target } } as never);
  }, [target]);

  useEffect(() => {
    if (user) moveOn();
  }, [moveOn, user]);

  const signUpWithApple = async () => {
    if (unavailable) return;
    void trackOnboardingEvent(api, 'auth_started', { step: 'join' });
    setAppleBusy(true);
    setNotice(null);
    try {
      await signInWithApple('signup');
    } catch (error) {
      if (!isAppleAuthCanceled(error)) setNotice(describeProviderSignInError(error, 'Apple'));
    } finally {
      setAppleBusy(false);
    }
  };

  const signUpWithGoogle = async () => {
    if (unavailable) return;
    void trackOnboardingEvent(api, 'auth_started', { step: 'join' });
    setGoogleBusy(true);
    setNotice(null);
    try {
      await signInWithGoogle();
    } catch (error) {
      if (!isGoogleAuthCanceled(error)) setNotice(describeProviderSignInError(error, 'Google'));
    } finally {
      setGoogleBusy(false);
    }
  };

  const logIn = () => {
    if (movedOn.current) return;
    movedOn.current = true;
    router.replace({ pathname: '/auth', params: { mode: 'login', returnTo: target } } as never);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: mediaColors.mediaScrimStrong, opacity: rise }]}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <Animated.View
        accessibilityViewIsModal
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: sheetHeight,
          borderTopLeftRadius: appTheme.radii.xl,
          borderTopRightRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          backgroundColor: theme.colors.panel,
          paddingTop: 10,
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] }) }],
        }}
      >
        <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.border }} />
        <IconButton
          icon={CloseGlyph}
          label="Close"
          variant="plain"
          onPress={close}
          style={{ position: 'absolute', top: 6, right: 8 }}
        />

        <View style={{ marginTop: 22, gap: 6, alignItems: 'center' }}>
          <AppText heading variant="sectionTitle" style={{ textAlign: 'center' }}>
            Sign up to start creating
          </AppText>
          <AppText variant="bodySm" color="muted" style={{ textAlign: 'center', maxWidth: 300 }}>
            Join free and get 25 credits for your first creations.
          </AppText>
        </View>

        <View style={{ flex: 1, minHeight: 200, marginTop: 14, marginHorizontal: -20, alignItems: 'center' }}>
          <DemoSlot width={width} />
        </View>

        {notice ? (
          <View accessibilityLiveRegion="polite" style={{ marginTop: 8, gap: 2 }}>
            <AppText variant="label" style={{ textAlign: 'center', color: theme.semantic.danger.foreground }}>{notice.title}</AppText>
            <AppText variant="caption" color="muted" style={{ textAlign: 'center' }}>{notice.body}</AppText>
          </View>
        ) : null}

        <View style={{ gap: appTheme.spacing.gap, marginTop: 12 }}>
          {providers.includes('Apple') ? (
            <View pointerEvents={unavailable ? 'none' : 'auto'} style={{ opacity: unavailable ? appTheme.opacity.disabled : 1 }}>
              <AppleAuthentication.AppleAuthenticationButton
                accessibilityLabel="Sign up with Apple"
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP}
                // Apple's rule for the system button: white on dark, black on light.
                buttonStyle={theme.scheme === 'dark'
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={BUTTON_HEIGHT / 2}
                onPress={() => void signUpWithApple()}
                style={{ width: '100%', height: BUTTON_HEIGHT }}
              />
            </View>
          ) : null}
          {providers.includes('Google') ? (
            <Pressable
              accessibilityRole="button"
              // Google's one asset reads "Sign in with Google" for sign-up too, so
              // the spoken name matches the drawn one and the hint says the rest.
              accessibilityLabel="Sign in with Google"
              accessibilityHint="Creates your account with Google and returns to Magicbooklet"
              accessibilityState={{ busy: googleBusy, disabled: unavailable }}
              disabled={unavailable}
              onPress={() => void signUpWithGoogle()}
              style={({ pressed }) => ({
                minHeight: BUTTON_HEIGHT,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: unavailable ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {googleBusy ? (
                <ActivityIndicator color={theme.colors.text} />
              ) : (
                <Image
                  accessibilityIgnoresInvertColors
                  contentFit="contain"
                  source={googleSignInArtwork}
                  style={{ width: BUTTON_HEIGHT * GOOGLE_BUTTON_ASPECT, height: BUTTON_HEIGHT }}
                />
              )}
            </Pressable>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Already have an account? Log in"
          onPress={logIn}
          style={{ minHeight: appTheme.touch.default, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}
        >
          <AppText variant="bodySm" color="muted">
            Already have an account?{' '}
            <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Log in</Text>
          </AppText>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** The demo takes whatever height the sheet leaves it. */
function DemoSlot({ width }: { width: number }) {
  const [slotHeight, setSlotHeight] = useState(0);
  return (
    <View
      style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center' }}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setSlotHeight((current) => (current === next ? current : next));
      }}
    >
      {slotHeight > 0 ? <WelcomeGenerateDemo width={width} height={slotHeight} /> : null}
    </View>
  );
}
