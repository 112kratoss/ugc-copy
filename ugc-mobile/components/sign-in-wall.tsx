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
import { router, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmailSignInForm } from '@/components/email-sign-in-form';
import { MediaWall } from '@/components/media-wall';
import { SignInProviderButtons, SignInTerms } from '@/components/sign-in-parts';
import { AppText, BrandLockup, IconButton } from '@/components/ui';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { useAuth } from '@/lib/auth';
import { describeProviderSignInError, type AuthNotice } from '@/lib/auth-error-copy';
import { completeAuthScreen, leaveAuthScreen, tookReturnsPlace } from '@/lib/auth-navigation';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { providerSignInNext } from '@/lib/join-navigation';
import { useReducedMotion } from '@/lib/motion';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { useNavigationBarSurface } from '@/lib/system-bars';
import { appTheme, mediaColors, SIGN_IN_WALL_SHADE } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';
import { useWelcomePromise } from '@/lib/welcome-promise';

const SIDE = 20;
/** The page turning between its two halves: quick enough to feel like one page. */
const TURN_MS = 360;

export type SignInWallMode = 'choose' | 'email';

/** A way into an account from the sign-in page. */
export type SignInMethod = 'apple' | 'google' | 'email';

/** One sign-in, run by the page for either half (see `runSignIn` below). */
export type RunSignIn = (method: SignInMethod, attempt: () => Promise<unknown>) => Promise<boolean>;

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
  const welcomePromise = useWelcomePromise();
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
  const [notice, setNotice] = useState<AuthNotice | null>(redirectNotice);
  // One sign-in at a time, from either half: each way in prepares the guest's credits for the
  // account before it replaces the session, so while one runs nothing else may start, and the
  // page may not be left or turned (that left a new account with no name step and no welcome
  // credits, or a sign-in landing on a screen the person had moved to).
  const [inFlight, setInFlight] = useState<SignInMethod | null>(null);
  const inFlightRef = useRef<SignInMethod | null>(null);
  const busy = inFlight !== null;
  const unavailable = !isAuthConfigured || busy;
  const navigation = useNavigation();
  // The visit's sign-in, kept here once for both halves: whether one began (for the funnel),
  // whether it finished, whether the page was left first, and how, which decides where it goes.
  const attempted = useRef(false);
  const completed = useRef(false);
  const canceled = useRef(false);
  const lastMethod = useRef<SignInMethod | null>(null);

  useEffect(() => {
    void trackOnboardingEvent(api, 'screen_viewed', { step });
  }, [api, step]);

  // A failed sign-in on the first half, read out on iOS too, where a live region says nothing.
  useEffect(() => {
    if (!notice || Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility(`${notice.title}. ${notice.body}`);
  }, [notice]);

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
    if (completed.current || inFlightRef.current) return;
    leaveAuthScreen(router);
  }, []);

  const backToChoices = useCallback(() => {
    if (inFlightRef.current) return;
    // The form's keyboard would cover Apple and Google, and keep typing into a hidden field.
    Keyboard.dismiss();
    turnTo('choose');
  }, [turnTo]);

  // Back on the email half turns the page back; on the first half it closes it.
  useHardwareBack(true, mode === 'email' ? backToChoices : close);

  // Left without finishing (Close, Android's back, or anything else that removes the page):
  // a sign-in landing after that goes nowhere, since the person is on the screen they went to.
  useEffect(() => navigation.addListener('beforeRemove', () => {
    if (completed.current || canceled.current) return;
    canceled.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_canceled', { step });
  }), [api, navigation, step]);

  // Signed in, by any way in (or already, if an account opened the page): once, from here.
  // Apple and Google go on to the name and the welcome credits (`providerSignInNext`); email,
  // and an account that opened the page signed in, go back to the return as the sign-in screen
  // always did (for a guest's `/join` that return is onboarding itself).
  const finish = useCallback(() => {
    if (completed.current) return;
    completed.current = true;
    if (attempted.current) void trackOnboardingEvent(api, 'auth_succeeded', { step });
    if (canceled.current) return;
    const inPlace = tookReturnsPlace(emailInPlace);
    if (lastMethod.current === 'email' || lastMethod.current === null) {
      completeAuthScreen(router, emailReturnTo, { inPlace });
      return;
    }
    const next = providerSignInNext(target, inPlace);
    if (next.kind === 'return') completeAuthScreen(router, next.route, { inPlace });
    else router.replace(next.href as never);
  }, [api, emailInPlace, emailReturnTo, step, target]);

  useEffect(() => {
    if (user && isFocused) finish();
  }, [finish, isFocused, user]);

  /**
   * Runs one sign-in for either half. Refuses while another runs, counts the visit's first
   * attempt, moves the page on once it lands, and hands a failure back to the caller to word.
   */
  const runSignIn = useCallback<RunSignIn>(async (method, attempt) => {
    if (inFlightRef.current || completed.current || !isAuthConfigured) return false;
    inFlightRef.current = method;
    setInFlight(method);
    if (!attempted.current) void trackOnboardingEvent(api, 'auth_started', { step });
    attempted.current = true;
    lastMethod.current = method;
    try {
      await attempt();
      finish();
      return true;
    } finally {
      inFlightRef.current = null;
      setInFlight(null);
    }
  }, [api, finish, isAuthConfigured, step]);

  const signUpWithApple = async () => {
    setNotice(null);
    try {
      await runSignIn('apple', () => signInWithApple('signup'));
    } catch (error) {
      if (!isAppleAuthCanceled(error)) setNotice(describeProviderSignInError(error, 'Apple'));
    }
  };

  const signUpWithGoogle = async () => {
    setNotice(null);
    try {
      await runSignIn('google', () => signInWithGoogle());
    } catch (error) {
      if (!isGoogleAuthCanceled(error)) setNotice(describeProviderSignInError(error, 'Google'));
    }
  };

  const useEmail = () => {
    if (busy || completed.current) return;
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

          {/* The welcome credits, unless an account on this phone has had them
              (owner, 2026-11-09; `lib/welcome-promise.ts`). */}
          <AppText variant="body" style={{ color: mediaColors.onMedia, textAlign: 'center', marginBottom: 14 }}>
            {welcomePromise ? (
              <>Join free and get <Text style={{ fontWeight: '700' }}>25 credits</Text> to start</>
            ) : 'Welcome back. Sign in to keep creating.'}
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
            appleBusy={inFlight === 'apple'}
            googleBusy={inFlight === 'google'}
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
            initialNotice={emailNotice}
            inFlight={inFlight}
            runSignIn={runSignIn}
            onBack={backToChoices}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
