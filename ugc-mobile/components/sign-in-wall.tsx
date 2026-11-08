// The one sign-in page (owner, 2026-11-08: "One full-screen page", "Create anything"): a wall
// of creations drifting behind a headline, then Apple, Google and email. It is what a guest
// sees when they reach for an account (`app/join.tsx`) and what every "Sign in" opens
// (`app/auth.tsx`, which keeps its email form behind "Sign in with email" and for the
// signed-out notice). Apple and Google make an account or sign into one, so a person who
// signs in here goes on to the creator name and the welcome credits once
// (`app/onboarding.tsx`, given the return), and from there back to what they were doing;
// an account already set up passes straight through.
import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Sparkles } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GoogleGMark } from '@/components/google-g-mark';
import { MediaWall } from '@/components/media-wall';
import { AppText, IconButton } from '@/components/ui';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { useAuth } from '@/lib/auth';
import { describeProviderSignInError, signInProviderButtons, type AuthNotice } from '@/lib/auth-error-copy';
import { leaveAuthScreen } from '@/lib/auth-navigation';
import { env } from '@/lib/env';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { appTheme, mediaColors, SIGN_IN_WALL_SHADE } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { useNavigationBarSurface } from '@/lib/system-bars';

/** Both provider buttons: Apple's system button scales its title to about 19pt at this height. */
const BUTTON_HEIGHT = 50;
const PROVIDER_LABEL_SIZE = 19;
const SIDE = 20;

/** Where a sign-in made here goes: the name and credits once, then `target`. */
export function signInWallNextHref(target: string) {
  return { pathname: '/onboarding', params: { returnTo: target } } as const;
}

export function SignInWall(props: {
  /** Where to end up once signed in: an app path, already checked. */
  target: string;
  /** The email form, for an account made with email before. */
  onUseEmail: () => void;
  /** The funnel step the events are filed under. */
  step: string;
}) {
  return (
    <ThemeScope scheme="dark">
      <SignInWallBody {...props} />
    </ThemeScope>
  );
}

function SignInWallBody({ target, onUseEmail, step }: { target: string; onUseEmail: () => void; step: string }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  // Android's navigation bar over the dark wall, as the first run's (app/onboarding.tsx).
  useNavigationBarSurface(isFocused ? 'dark' : null);
  const { width, height } = useWindowDimensions();
  const { api, user, signInWithApple, signInWithGoogle, isAuthConfigured } = useAuth();
  const providers = signInProviderButtons(Platform.OS);
  const [appleBusy, setAppleBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const busy = appleBusy || googleBusy;
  const unavailable = !isAuthConfigured || busy;
  const movedOn = useRef(false);
  // A sign-in started here, for the funnel: success when it lands, a cancel when the page is
  // closed after one began and before it did.
  const attempted = useRef(false);

  useEffect(() => {
    void trackOnboardingEvent(api, 'screen_viewed', { step });
  }, [api, step]);

  const close = useCallback(() => {
    // Not while a sign-in is finishing (the guest's credits being carried over, Apple's token,
    // Google's code): closing then left a new account with no name step and no welcome credits.
    if (movedOn.current || busy) return;
    movedOn.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_canceled', { step });
    leaveAuthScreen(router);
  }, [api, busy, step]);

  useHardwareBack(true, close);

  // Signed in, by either button (or already, if an account opened the page): on to the name
  // and the welcome credits, which come back to `target`.
  const moveOn = useCallback(() => {
    if (movedOn.current) return;
    movedOn.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_succeeded', { step });
    router.replace(signInWallNextHref(target) as never);
  }, [api, step, target]);

  useEffect(() => {
    if (user) moveOn();
  }, [moveOn, user]);

  const noteAttempt = () => {
    if (!attempted.current) void trackOnboardingEvent(api, 'auth_started', { step });
    attempted.current = true;
  };

  const signUpWithApple = async () => {
    if (unavailable) return;
    noteAttempt();
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
    noteAttempt();
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

  const useEmail = () => {
    if (busy || movedOn.current) return;
    onUseEmail();
  };

  return (
    <View style={{ flex: 1, backgroundColor: mediaColors.mediaGround }}>
      {isFocused ? <StatusBar style="light" /> : null}
      <MediaWall width={width} height={height} />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', inset: 0, experimental_backgroundImage: SIGN_IN_WALL_SHADE }}
      />

      {/* Scrolls only when it has to: at the largest text sizes on a small phone, so the
          buttons are never pushed off the screen. */}
      <ScrollView
        style={{ flex: 1 }}
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
        // No field on this page; a keyboard left up by the page beneath gives way to the tap.
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 4,
          paddingBottom: Math.max(insets.bottom, 16) + 4,
          paddingHorizontal: SIDE,
        }}
      >
        <IconButton
          icon={CloseGlyph}
          label="Close"
          variant="plain"
          disabled={busy}
          onPress={close}
          // The glyph's left edge on the headline's.
          style={{ alignSelf: 'flex-start', marginLeft: -12 }}
        />

        <View style={{ marginTop: 20, gap: 12, maxWidth: 360 }}>
          <AppText
            heading
            variant="display"
            maxFontSizeMultiplier={1.3}
            style={{ color: mediaColors.onMedia, fontSize: 52, lineHeight: 56, letterSpacing: -1.2 }}
          >
            {'Create\nanything'}
          </AppText>
          {/* A small mark under the headline, as Kling's is: the full lockup is a page title. */}
          <View accessibilityRole="header" accessibilityLabel="Magicbooklet" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Sparkles size={appTheme.icon.compact} color={theme.colors.primary} />
            <AppText variant="sectionTitle" style={{ color: mediaColors.onMedia, fontSize: 19, lineHeight: 24 }}>
              Magicbooklet
            </AppText>
          </View>
        </View>

        <View style={{ flex: 1, minHeight: 24 }} />

        <AppText variant="body" style={{ color: mediaColors.onMedia, textAlign: 'center', marginBottom: 14 }}>
          Join free and get 25 credits to start
        </AppText>

        {notice ? (
          <View accessibilityLiveRegion="polite" style={{ marginBottom: 10, gap: 2 }}>
            <AppText variant="label" style={{ textAlign: 'center', color: theme.semantic.danger.foreground }}>{notice.title}</AppText>
            <AppText variant="caption" style={{ textAlign: 'center', color: mediaColors.onMediaSecondary }}>{notice.body}</AppText>
          </View>
        ) : null}

        {/* One width, one height, one label size: Apple's system button and a drawn Google
            button to match it, both white on the dark wall. Android has Google alone, and it
            leads there just as Apple does on iOS. */}
        <View style={{ gap: appTheme.spacing.gap, width: '100%', maxWidth: 430, alignSelf: 'center' }}>
          {providers.includes('Apple') ? (
            <View pointerEvents={unavailable ? 'none' : 'auto'} style={{ opacity: unavailable ? appTheme.opacity.disabled : 1 }}>
              <AppleAuthentication.AppleAuthenticationButton
                accessibilityLabel="Continue with Apple"
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                // Apple's rule for the system button: white on a dark background.
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={BUTTON_HEIGHT / 2}
                onPress={() => void signUpWithApple()}
                style={{ width: '100%', height: BUTTON_HEIGHT }}
              />
            </View>
          ) : null}
          {providers.includes('Google') ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              accessibilityHint="Signs in, or creates your account, with Google"
              accessibilityState={{ busy: googleBusy, disabled: unavailable }}
              disabled={unavailable}
              onPress={() => void signUpWithGoogle()}
              style={({ pressed }) => ({
                height: BUTTON_HEIGHT,
                borderRadius: appTheme.radii.pill,
                backgroundColor: mediaColors.onMedia,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: unavailable ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {googleBusy ? (
                <ActivityIndicator color={mediaColors.mediaGround} />
              ) : (
                <>
                  <GoogleGMark size={20} />
                  <Text
                    maxFontSizeMultiplier={1.3}
                    style={{ color: mediaColors.mediaGround, fontSize: PROVIDER_LABEL_SIZE, fontWeight: '600', letterSpacing: -0.2 }}
                  >
                    Continue with Google
                  </Text>
                </>
              )}
            </Pressable>
          ) : null}
        </View>

        {/* Email makes no new accounts, so it is a way back in for one, not a third button. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign in with email"
          accessibilityHint="For an account you made with email"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={useEmail}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.default,
            marginTop: 6,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: busy ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <Text style={{ color: mediaColors.onMediaSecondary, fontSize: 15, lineHeight: 20, textAlign: 'center' }}>
            Made an account with email?{' '}
            <Text style={{ color: mediaColors.onMedia, fontWeight: '700' }}>Sign in</Text>
          </Text>
        </Pressable>

        <View style={{ marginTop: 4, alignItems: 'center', gap: 2 }}>
          <Text style={{ color: mediaColors.onMediaSecondary, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>
            By continuing, you agree to the Magicbooklet terms and privacy policy.
          </Text>
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <TermsLink label="Terms of Service" path="/terms" />
            <TermsLink label="Privacy Policy" path="/privacy" />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function TermsLink({ label, path }: { label: string; path: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${label.toLowerCase()}`}
      onPress={() => void Linking.openURL(`${env.siteUrl}${path}`)}
      // A 13pt line reached from a full 44pt row.
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      style={({ pressed }) => ({ paddingVertical: 2, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Text style={{ color: mediaColors.onMedia, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
