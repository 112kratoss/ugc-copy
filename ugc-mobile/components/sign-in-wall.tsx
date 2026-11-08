// The one sign-in page (owner, 2026-11-08: "One full-screen page", "Start filling your"): a wall
// of creations drifting behind a headline, then Apple, Google and email. It is what a guest
// sees when they reach for an account (`app/join.tsx`) and what every "Sign in" opens
// (`app/auth.tsx`). "Sign in with email" turns the same page into the email form in place,
// over the same moving wall (owner: "instead of going to another page … a smooth transition
// into the sign in section … keep the background moving too"), and X or Back turns it back.
// Apple and Google make an account or sign into one, so a person who signs in here goes on to
// the creator name and the welcome credits once (`app/onboarding.tsx`, given the return), and
// from there back to what they were doing; an account already set up passes straight through.
import { useIsFocused } from '@react-navigation/native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmailSignInForm } from '@/components/email-sign-in-form';
import { MediaWall } from '@/components/media-wall';
import { SignInProviderButtons, SignInTerms } from '@/components/sign-in-parts';
import { AppText, BrandLockup, IconButton } from '@/components/ui';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { useAuth } from '@/lib/auth';
import { describeProviderSignInError, type AuthNotice } from '@/lib/auth-error-copy';
import { leaveAuthScreen } from '@/lib/auth-navigation';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { useNavigationBarSurface } from '@/lib/system-bars';
import { appTheme, mediaColors, SIGN_IN_WALL_SHADE } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';

const SIDE = 20;
/** The page turning between its two halves: quick enough to feel like one page. */
const TURN_MS = 360;

export type SignInWallMode = 'choose' | 'email';

/** Where a sign-in made here goes: the name and credits once, then `target`. */
export function signInWallNextHref(target: string) {
  return { pathname: '/onboarding', params: { returnTo: target } } as const;
}

type SignInWallProps = {
  /** Where to end up once signed in: an app path, already checked. */
  target: string;
  /** The funnel step the events are filed under. */
  step: string;
  /** Why a redirect sent the person here ("You were signed out"), if it did. */
  notice?: AuthNotice | null;
  /** The half the page opens on. */
  initialMode?: SignInWallMode;
  /** Where an email sign-in returns, as the route hands it on. */
  emailReturnTo: string | string[] | undefined;
  emailInPlace?: string | string[];
  /** A redirect's notice, when the page opens on the email form. */
  emailNotice?: AuthNotice | null;
};

export function SignInWall(props: SignInWallProps) {
  return (
    <ThemeScope scheme="dark">
      <SignInWallBody {...props} />
    </ThemeScope>
  );
}

function SignInWallBody({
  target,
  step,
  notice: redirectNotice = null,
  initialMode = 'choose',
  emailReturnTo,
  emailInPlace,
  emailNotice = null,
}: SignInWallProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const reducedMotion = useReducedMotion();
  // Android's navigation bar over the dark wall, as the first run's (app/onboarding.tsx).
  useNavigationBarSurface(isFocused ? 'dark' : null);
  const { width, height } = useWindowDimensions();
  const { api, user, signInWithApple, signInWithGoogle, isAuthConfigured } = useAuth();
  const [mode, setMode] = useState<SignInWallMode>(initialMode);
  // The form is built the first time it is asked for, then kept, so turning back and forth
  // keeps what was typed.
  const [formBuilt, setFormBuilt] = useState(initialMode === 'email');
  const [turn] = useState(() => new Animated.Value(initialMode === 'email' ? 1 : 0, { useNativeDriver: true }));
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

  const turnTo = useCallback((next: SignInWallMode) => {
    if (next === 'email') setFormBuilt(true);
    setMode(next);
    Animated.timing(turn, {
      toValue: next === 'email' ? 1 : 0,
      duration: reducedMotion ? 0 : TURN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, turn]);

  const close = useCallback(() => {
    // Not while a sign-in is finishing (the guest's credits being carried over, Apple's token,
    // Google's code): closing then left a new account with no name step and no welcome credits.
    if (movedOn.current || busy) return;
    movedOn.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_canceled', { step });
    leaveAuthScreen(router);
  }, [api, busy, step]);

  const backToChoices = useCallback(() => turnTo('choose'), [turnTo]);

  // Back on the email half turns the page back; on the first half it closes it.
  useHardwareBack(true, mode === 'email' ? backToChoices : close);

  // Signed in, by either button (or already, if an account opened the page): on to the name
  // and the welcome credits, which come back to `target`.
  const moveOn = useCallback(() => {
    if (movedOn.current) return;
    movedOn.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_succeeded', { step });
    router.replace(signInWallNextHref(target) as never);
  }, [api, step, target]);

  // Only on the first half and in front: on the email half the form takes its own sign-in
  // where it goes, and two moves at once would stack a second onboarding.
  useEffect(() => {
    if (user && isFocused && mode === 'choose') moveOn();
  }, [isFocused, mode, moveOn, user]);

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
    turnTo('email');
  };

  const onChoose = mode === 'choose';

  return (
    <View style={{ flex: 1, backgroundColor: mediaColors.mediaGround }}>
      {isFocused ? <StatusBar style="light" /> : null}
      {/* The wall keeps moving under both halves. */}
      <MediaWall width={width} height={height} />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', inset: 0, experimental_backgroundImage: SIGN_IN_WALL_SHADE }}
      />
      {/* Deeper behind the email half, where fields are read and typed in. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: mediaColors.mediaScrimStrong, opacity: turn }]}
      />

      {/* The first half: fades up and away as the email half rises in. */}
      <Animated.View
        pointerEvents={onChoose ? 'auto' : 'none'}
        accessibilityElementsHidden={!onChoose}
        importantForAccessibility={onChoose ? 'auto' : 'no-hide-descendants'}
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: turn.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0] }),
            transform: [{ translateY: turn.interpolate({ inputRange: [0, 1], outputRange: [0, -28] }) }],
          },
        ]}
      >
        {/* Scrolls only when it has to: at the largest text sizes on a small phone, so the
            buttons are never pushed off the screen. */}
        <ScrollView
          style={{ flex: 1 }}
          alwaysBounceVertical={false}
          showsVerticalScrollIndicator={false}
          // No field on this half; a keyboard left up by the page beneath gives way to the tap.
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
              with the name below it), at a size that finishes the sentence, and is read as the
              one line it is: "Start filling your Magicbooklet" (owner, 2026-11-08). */}
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel="Start filling your Magicbooklet"
            style={{ marginTop: 20, gap: 6, maxWidth: 360 }}
          >
            <AppText
              variant="display"
              maxFontSizeMultiplier={1.3}
              style={{ color: mediaColors.onMedia, fontSize: 52, lineHeight: 56, letterSpacing: -1.2 }}
            >
              {'Start\nfilling your'}
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
      </Animated.View>

      {/* The email half: rises into place as the first half leaves. */}
      {formBuilt ? (
        <Animated.View
          pointerEvents={onChoose ? 'none' : 'auto'}
          accessibilityElementsHidden={onChoose}
          importantForAccessibility={onChoose ? 'no-hide-descendants' : 'auto'}
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: turn.interpolate({ inputRange: [0, 0.2, 0.85, 1], outputRange: [0, 0, 1, 1] }),
              transform: [{ translateY: turn.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }],
            },
          ]}
        >
          <EmailSignInForm
            returnTo={emailReturnTo}
            inPlace={emailInPlace}
            initialNotice={emailNotice}
            analyticsStep={step}
            active={!onChoose}
            onBack={backToChoices}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
