// The one sign-in page (owner, 2026-11-08: "One full-screen page", "Start creating in"): a wall
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
import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GoogleGMark } from '@/components/google-g-mark';
import { MediaWall } from '@/components/media-wall';
import { AppText, BrandLockup, IconButton } from '@/components/ui';
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
  /** Why a redirect sent the person here ("You were signed out"), if it did. */
  notice?: AuthNotice | null;
}) {
  return (
    <ThemeScope scheme="dark">
      <SignInWallBody {...props} />
    </ThemeScope>
  );
}

function SignInWallBody({ target, onUseEmail, step, notice: redirectNotice = null }: {
  target: string;
  onUseEmail: () => void;
  step: string;
  notice?: AuthNotice | null;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  // Android's navigation bar over the dark wall, as the first run's (app/onboarding.tsx).
  useNavigationBarSurface(isFocused ? 'dark' : null);
  const { width, height } = useWindowDimensions();
  const { api, user, signInWithApple, signInWithGoogle, isAuthConfigured } = useAuth();
  const [appleBusy, setAppleBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(redirectNotice);
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

  // Only while in front: with the email form over this page, that form takes its own sign-in
  // where it goes, and two moves at once would stack a second onboarding.
  useEffect(() => {
    if (user && isFocused) moveOn();
  }, [isFocused, moveOn, user]);

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

        {/* The headline runs on into the wordmark (owner, 2026-11-08: like "Start working in",
            with the name below it), at a size that finishes the sentence, and is read as the one
            line it is: "Start creating in Magicbooklet". */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel="Start creating in Magicbooklet"
          style={{ marginTop: 20, gap: 6, maxWidth: 360 }}
        >
          <AppText
            variant="display"
            maxFontSizeMultiplier={1.3}
            style={{ color: mediaColors.onMedia, fontSize: 52, lineHeight: 56, letterSpacing: -1.2 }}
          >
            {'Start\ncreating in'}
          </AppText>
          <View style={{ alignSelf: 'flex-start' }}>
            <BrandLockup size="title" />
          </View>
        </View>

        <View style={{ flex: 1, minHeight: 24 }} />

        <AppText variant="body" style={{ color: mediaColors.onMedia, textAlign: 'center', marginBottom: 14 }}>
          Join free and get <Text style={{ fontWeight: '700' }}>25 credits</Text> to start
        </AppText>

        {notice ? (
          <View accessibilityLiveRegion="polite" style={{ marginBottom: 10, gap: 2 }}>
            <AppText
              variant="label"
              style={{ textAlign: 'center', color: notice.tone === 'info' ? mediaColors.onMedia : theme.semantic.danger.foreground }}
            >
              {notice.title}
            </AppText>
            <AppText variant="caption" style={{ textAlign: 'center', color: mediaColors.onMediaSecondary }}>{notice.body}</AppText>
          </View>
        ) : null}

        <SignInProviderButtons
          onApple={() => void signUpWithApple()}
          onGoogle={() => void signUpWithGoogle()}
          appleBusy={appleBusy}
          googleBusy={googleBusy}
          unavailable={unavailable}
        />

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

        <View style={{ marginTop: 4 }}>
          <SignInTerms />
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * Apple and Google, as both sign-in screens draw them: one width, one height, one label size.
 * Apple's system button and a drawn Google button to match it, both white on the dark wall.
 * Android has Google alone, and it leads there just as Apple does on iOS.
 */
export function SignInProviderButtons({ onApple, onGoogle, appleBusy, googleBusy, unavailable }: {
  onApple: () => void;
  onGoogle: () => void;
  appleBusy: boolean;
  googleBusy: boolean;
  /** A sign-in is under way, or auth is not configured: the buttons wait. */
  unavailable: boolean;
}) {
  const providers = signInProviderButtons(Platform.OS);
  return (
    <View style={{ gap: appTheme.spacing.gap, width: '100%', maxWidth: 430, alignSelf: 'center' }}>
      {providers.includes('Apple') ? (
        <View
          pointerEvents={unavailable ? 'none' : 'auto'}
          style={{ opacity: unavailable && !appleBusy ? appTheme.opacity.disabled : 1 }}
        >
          <AppleAuthentication.AppleAuthenticationButton
            accessibilityLabel="Continue with Apple"
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            // Apple's rule for the system button: white on a dark background.
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={BUTTON_HEIGHT / 2}
            onPress={onApple}
            style={{ width: '100%', height: BUTTON_HEIGHT }}
          />
          {/* Apple's button cannot show progress itself; the same spinner Google's shows,
              over it, while its sign-in finishes. */}
          {appleBusy ? (
            <View
              accessibilityLabel="Signing in with Apple"
              accessibilityLiveRegion="polite"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: appTheme.radii.pill,
                backgroundColor: mediaColors.onMedia,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ActivityIndicator color={mediaColors.mediaGround} />
            </View>
          ) : null}
        </View>
      ) : null}
      {providers.includes('Google') ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          accessibilityHint="Signs in, or creates your account, with Google"
          accessibilityState={{ busy: googleBusy, disabled: unavailable }}
          disabled={unavailable}
          onPress={onGoogle}
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
  );
}

/**
 * The terms line both sign-in screens end on, white on the wall: one sentence whose two
 * documents are its links, each its own control with a full reach.
 */
export function SignInTerms() {
  const words = { color: mediaColors.onMediaSecondary, fontSize: 13, lineHeight: 18 } as const;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: 4 }}>
      <Text style={words}>By continuing you agree to our</Text>
      <TermsLink label="Terms" spoken="terms of service" path="/terms" />
      <Text style={words}>and</Text>
      <TermsLink label="Privacy Policy" spoken="privacy policy" path="/privacy" />
    </View>
  );
}

function TermsLink({ label, spoken, path }: { label: string; spoken: string; path: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${spoken}`}
      onPress={() => void Linking.openURL(`${env.siteUrl}${path}`)}
      // A 13pt line reached from a full 44pt row.
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      style={({ pressed }) => ({ paddingVertical: 2, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Text style={{ color: mediaColors.onMedia, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
