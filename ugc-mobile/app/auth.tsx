import { useIsFocused, useRoute } from '@react-navigation/native';
import { router, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Eye, EyeOff, LockKeyhole, Mail, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { MediaWall } from '@/components/media-wall';
import { SignInProviderButtons, SignInTerms, SignInWall } from '@/components/sign-in-wall';
import { AppText, BrandLockup, IconButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  SIGN_IN_SUPPORT,
  SIGN_IN_SUPPORT_MAIL_URL,
  authNoticeForRedirect,
  describePasswordSignInError,
  describeProviderSignInError,
  signInProviderButtons,
  validateCredentials,
  type AuthNotice,
} from '@/lib/auth-error-copy';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { completeAuthScreen, leaveAuthScreen, normalizeAuthReturnTo, tookReturnsPlace } from '@/lib/auth-navigation';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { providerSignInHref, signInOpensOnEmailForm } from '@/lib/join-navigation';
import { trackOnboardingEvent } from '@/lib/onboarding';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { useNavigationBarSurface } from '@/lib/system-bars';
import { appTheme, mediaColors } from '@/lib/theme';
import { ThemeScope, useAppTheme } from '@/lib/theme-context';

/** The sign-in page's button height (`components/sign-in-wall.tsx`). */
const SUBMIT_HEIGHT = 50;

/**
 * Where a sign-in begun here was headed, as the `step` of its analytics events
 * (audit 01-11): the return route's path, without a query that can carry what
 * someone searched for, and within the 64 characters the events route takes.
 */
function authAnalyticsStep(returnTo: string | string[] | undefined) {
  const destination = normalizeAuthReturnTo(returnTo) ?? '/(tabs)';
  return (destination.split(/[?#]/, 1)[0] || '/(tabs)').slice(0, 64);
}

/**
 * Every "Sign in" opens the full-screen sign-in page (owner, 2026-11-08: one page for signing
 * up and in, `components/sign-in-wall.tsx`), a redirect's notice ("You were signed out") on it
 * included, since most accounts come back with Apple or Google. The email form below is for an
 * account made with email, behind the page's "Sign in with email".
 */
export default function AuthRoute() {
  const { returnTo, notice, email } = (useRoute().params ?? {}) as {
    returnTo?: string | string[];
    notice?: string | string[];
    email?: string | string[];
  };
  const [showEmailForm, setShowEmailForm] = useState(() => signInOpensOnEmailForm(email));

  if (!showEmailForm) {
    return (
      <SignInWall
        target={normalizeAuthReturnTo(returnTo) ?? '/(tabs)'}
        step={authAnalyticsStep(returnTo)}
        notice={authNoticeForRedirect(notice)}
        onUseEmail={() => setShowEmailForm(true)}
      />
    );
  }
  return <AuthScreen />;
}

function AuthScreen() {
  // Dark in both schemes, over the same wall as the sign-in page it is reached from.
  return (
    <ThemeScope scheme="dark">
      <EmailSignIn />
    </ThemeScope>
  );
}

/**
 * The email form (owner, 2026-11-08: "Dark, same wall"): email and password over the sign-in
 * page's wall of creations. Email signs into an account made with email; it makes none, so the
 * old Sign in / Sign up tabs went. Apple and Google stay under it (owner: "Yes, add them").
 */
function EmailSignIn() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  useNavigationBarSurface(isFocused ? 'dark' : null);
  const { width, height } = useWindowDimensions();
  // The route's own params: the URL parse has decoded them once, as every caller encoded its
  // return once. expo-router's `useLocalSearchParams` decodes them again, which cut a prompt in a
  // return at & or #, turned its + into a space, and sent one with a backslash or a line break Home.
  const { returnTo, notice: requestedNotice, inPlace } = (useRoute().params ?? {}) as {
    returnTo?: string | string[];
    notice?: string | string[];
    inPlace?: string | string[];
  };
  const { api, user, signInWithPassword, signInWithApple, signInWithGoogle, isAuthConfigured, missingEnvKeys } = useAuth();
  const navigation = useNavigation();
  // The buttons the sign-in page draws on this platform, and so the only ones the copy may name.
  const providerButtons = signInProviderButtons(Platform.OS);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Seeded from the route so a redirect can say why it sent the person here.
  // Only a known key maps to copy; an unrecognised one shows nothing rather
  // than letting a deep link put arbitrary text on the sign-in screen.
  const [notice, setNotice] = useState<AuthNotice | null>(() => authNoticeForRedirect(requestedNotice));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleSubmitting, setIsAppleSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  // One sign-in at a time: each way in prepares the guest's credits for the account before it
  // replaces the session, and a second tap would start another over it.
  const isSignInInFlight = isSubmitting || isAppleSubmitting || isGoogleSubmitting;
  // Apple or Google can make an account here too, so their sign-in goes on through the name
  // and the welcome credits, as it does from the sign-in page.
  const viaProvider = useRef(false);
  const passwordRef = useRef<TextInput | null>(null);
  // Deliberately not a validity gate. A button that is disabled for a reason it
  // cannot state leaves people guessing (the old gate wanted six characters and
  // said so only in a placeholder that vanished on the first keystroke); the
  // shape of what was typed is checked on submit instead, where it can be named.
  const canSubmit = isAuthConfigured && !isSignInInFlight && email.trim().length > 0 && password.length > 0;
  const hasCompletedAuth = useRef(false);
  const hasStartedAuth = useRef(false);
  const hasCanceledAuth = useRef(false);
  const analyticsStep = authAnalyticsStep(returnTo);

  // Fire-and-forget: a sign-in never waits on its own measurement.
  const trackAuthEvent = useCallback((eventName: 'auth_started' | 'auth_succeeded' | 'auth_canceled') => {
    void trackOnboardingEvent(api, eventName, { step: analyticsStep });
  }, [analyticsStep, api]);

  const finishAuth = useCallback(() => {
    if (hasCompletedAuth.current) return;
    hasCompletedAuth.current = true;
    // A sign-in made here. Opened by someone signed in already, the screen
    // only steps aside, and nothing was signed in.
    if (hasStartedAuth.current) trackAuthEvent('auth_succeeded');
    // Left before its sign-in finished (Close, Android's back): the person is
    // on the screen they went to, which a return would replace.
    if (hasCanceledAuth.current) return;
    if (viaProvider.current) {
      router.replace(providerSignInHref(returnTo) as never);
      return;
    }
    completeAuthScreen(router, returnTo, { inPlace: tookReturnsPlace(inPlace) });
  }, [inPlace, returnTo, trackAuthEvent]);

  useEffect(() => {
    if (user) finishAuth();
  }, [finishAuth, user]);

  // Left without signing in: the Close button, Android's back. A sign-in's own
  // exit is marked completed before it leaves.
  useEffect(() => navigation.addListener('beforeRemove', () => {
    if (hasCompletedAuth.current || hasCanceledAuth.current) return;
    hasCanceledAuth.current = true;
    trackAuthEvent('auth_canceled');
  }), [navigation, trackAuthEvent]);

  // Once a visit, at the first attempt by any of the screen's ways in.
  const noteAuthStarted = () => {
    if (hasStartedAuth.current) return;
    hasStartedAuth.current = true;
    trackAuthEvent('auth_started');
  };

  const continueWithApple = async () => {
    if (isSignInInFlight || !isAuthConfigured) return;
    noteAuthStarted();
    viaProvider.current = true;
    setIsAppleSubmitting(true);
    setNotice(null);
    try {
      await signInWithApple('signup');
      finishAuth();
    } catch (nextError) {
      viaProvider.current = false;
      if (!isAppleAuthCanceled(nextError)) setNotice(describeProviderSignInError(nextError, 'Apple'));
    } finally {
      setIsAppleSubmitting(false);
    }
  };

  const continueWithGoogle = async () => {
    if (isSignInInFlight || !isAuthConfigured) return;
    noteAuthStarted();
    viaProvider.current = true;
    setIsGoogleSubmitting(true);
    setNotice(null);
    try {
      await signInWithGoogle();
      finishAuth();
    } catch (nextError) {
      viaProvider.current = false;
      if (!isGoogleAuthCanceled(nextError)) setNotice(describeProviderSignInError(nextError, 'Google'));
    } finally {
      setIsGoogleSubmitting(false);
    }
  };

  const submit = async () => {
    if (isSignInInFlight) return;
    noteAuthStarted();

    const invalid = validateCredentials(email, password);
    if (invalid) {
      setNotice(invalid);
      return;
    }

    setIsSubmitting(true);
    setNotice(null);
    try {
      await signInWithPassword(email.trim(), password);
      finishAuth();
    } catch (nextError) {
      setNotice(describePasswordSignInError(nextError, { providerButtons }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: mediaColors.mediaGround }}>
      {isFocused ? <StatusBar style="light" /> : null}
      <MediaWall width={width} height={height} />
      {/* Darker than the page before: here the wall sits behind fields that are read and typed in. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: mediaColors.mediaScrimStrong }]} />
      <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 4,
          paddingBottom: Math.max(insets.bottom, 16) + 4,
          paddingHorizontal: 20,
        }}
      >
        <View style={{ width: '100%', maxWidth: 430, alignSelf: 'center', flex: 1 }}>
          <IconButton
            icon={CloseGlyph}
            label="Close"
            variant="plain"
            onPress={() => leaveAuthScreen(router)}
            // The glyph's left edge on the title's.
            style={{ alignSelf: 'flex-start', marginLeft: -12 }}
          />

          <View style={{ marginTop: 16, gap: 8 }}>
            <View style={{ alignSelf: 'flex-start', marginBottom: 12 }}>
              <BrandLockup />
            </View>
            <AppText heading variant="pageTitle" style={{ color: mediaColors.onMedia }}>
              Sign in with email
            </AppText>
            <AppText variant="body" style={{ color: mediaColors.onMediaSecondary }}>
              For an account you made with email. New accounts start with Apple or Google.
            </AppText>
          </View>

          <View style={{ marginTop: 28, gap: 14 }}>
            {!isAuthConfigured ? (
              <InlineNotice
                title="Mobile auth is not configured"
                body={`Add ${missingEnvKeys.join(', ')} to ugc-mobile/.env.local and restart Expo.`}
              />
            ) : null}

            <WorkspaceInput
              label="Email"
              icon={<Mail size={appTheme.icon.compact} color={theme.colors.primary} />}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="email-address"
              // `username` rather than `emailAddress`: paired with the
              // `password` field below it, this is what makes iCloud Keychain
              // and Google Password Manager offer a saved login above the
              // keyboard instead of only contact-card autofill.
              textContentType="username"
              autoComplete="username"
              returnKeyType="next"
              // Keep the keyboard up while focus moves to the password field.
              submitBehavior="submit"
              onSubmitEditing={() => passwordRef.current?.focus()}
              value={email}
              onChangeText={(value) => {
                setEmail(value);
                setNotice(null);
              }}
              placeholder="you@example.com"
              trailingIcon={email.length > 0 ? (
                // Text fields, iOS: "Display a Clear button in the trailing end of
                // a text field to help people erase their input." Drawn rather
                // than left to `clearButtonMode`, which is iOS-only — this is the
                // same control on both platforms.
                <FieldButton label="Clear email" onPress={() => setEmail('')}>
                  <X size={appTheme.icon.compact} color={theme.colors.muted} />
                </FieldButton>
              ) : null}
            />
            <WorkspaceInput
              label="Password"
              inputRef={passwordRef}
              icon={<LockKeyhole size={appTheme.icon.compact} color={theme.colors.primary} />}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canSubmit) void submit();
              }}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setNotice(null);
              }}
              placeholder="Your password"
              trailingIcon={
                <FieldButton
                  label={showPassword ? 'Hide password' : 'Show password'}
                  onPress={() => setShowPassword((current) => !current)}
                >
                  {/* Two glyphs, not one glyph in two colours — HIG Color: "avoid
                      relying solely on color to … communicate essential
                      information", the rule S13 applied to the profile grid. */}
                  {showPassword
                    ? <EyeOff size={appTheme.icon.compact} color={theme.colors.primary} />
                    : <Eye size={appTheme.icon.compact} color={theme.colors.muted} />}
                </FieldButton>
              }
            />

            <SignInSupportLink />

            {/* Above the action, so it survives the keyboard: the password field's
                Return key is "go", which submits with the keyboard up. */}
            {notice ? <InlineNotice title={notice.title} body={notice.body} tone={notice.tone} /> : null}

            {/* White, as the sign-in page's buttons are. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isSubmitting ? 'Signing in…' : 'Sign in'}
              accessibilityState={{ disabled: !canSubmit, busy: isSubmitting }}
              disabled={!canSubmit}
              onPress={() => void submit()}
              style={({ pressed }) => ({
                height: SUBMIT_HEIGHT,
                borderRadius: appTheme.radii.pill,
                backgroundColor: mediaColors.onMedia,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: !canSubmit && !isSubmitting ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {isSubmitting ? <ActivityIndicator color={mediaColors.mediaGround} /> : null}
              <Text style={{ color: mediaColors.mediaGround, fontSize: 19, fontWeight: '600', letterSpacing: -0.2 }}>
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Text>
            </Pressable>

            {/* For an account made with Apple or Google, which the wrong-password copy points
                at, and for anyone who reached email by mistake: the X leaves sign-in. */}
            <OrDivider />
            <SignInProviderButtons
              onApple={() => void continueWithApple()}
              onGoogle={() => void continueWithGoogle()}
              googleBusy={isGoogleSubmitting}
              unavailable={!isAuthConfigured || isSignInInFlight}
            />
          </View>

          <View style={{ flex: 1, minHeight: 24 }} />
          <SignInTerms />
        </View>
      </ScrollView>
      </KeyboardAvoidingArea>
    </View>
  );
}

/** "or", between the email form and Apple and Google. */
function OrDivider() {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 2 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
      <Text style={{ color: mediaColors.onMediaSecondary, fontSize: 13, fontWeight: '600' }}>or</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
    </View>
  );
}

/**
 * Where "Forgot password?" stood (decision D2). There is no reset to offer:
 * Magicbooklet has no mail sender, so the link led to a form whose mail never
 * came (audit 01-2). The few accounts made with a password before July are
 * helped by support instead, and so is anyone else who cannot get in. The
 * address is written out, so it is there to copy where no mail app opens; the
 * two halves wrap as a pair, never breaking the address across lines.
 */
function SignInSupportLink() {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${SIGN_IN_SUPPORT.prompt} ${SIGN_IN_SUPPORT.action}`}
      accessibilityHint="Opens your email app"
      onPress={() => {
        // A phone with no mail app refuses the link; the address stays on screen.
        Linking.openURL(SIGN_IN_SUPPORT_MAIL_URL).catch(() => undefined);
      }}
      style={({ pressed }) => ({
        alignSelf: 'flex-end',
        minHeight: MIN_HIT_TARGET_PT,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        columnGap: appTheme.spacing.unit,
        paddingHorizontal: appTheme.spacing.unit,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <Text style={{ color: theme.colors.muted, fontSize: 14, lineHeight: 20, fontWeight: '400' }}>
        {SIGN_IN_SUPPORT.prompt}
      </Text>
      <Text style={{ color: theme.colors.primary, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
        {SIGN_IN_SUPPORT.action}
      </Text>
    </Pressable>
  );
}

/** A control inside a text field, at the HIG's 44pt floor rather than icon-sized. */
function FieldButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: MIN_HIT_TARGET_PT,
        height: MIN_HIT_TARGET_PT,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function WorkspaceInput({
  label,
  icon,
  trailingIcon,
  inputRef,
  ...props
}: TextInputProps & {
  /**
   * Text fields: "Because placeholder text disappears when people start typing,
   * it can also be useful to include a separate label describing the field to
   * remind people of its purpose." Drawn the way `AppTextInput` draws it, so
   * the app's fields all label themselves the same way.
   */
  label: string;
  icon: React.ReactNode;
  trailingIcon?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <View
        style={{
          minHeight: 56,
          borderRadius: appTheme.radii.md,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          backgroundColor: theme.colors.surfaceInset,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 13,
          paddingRight: trailingIcon ? 6 : 14,
          gap: 10,
        }}
      >
        <View style={{ width: 32, height: 32, borderRadius: appTheme.radii.xs, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.pressed }}>
          {icon}
        </View>
        <TextInput
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={theme.colors.faint}
          selectionColor={theme.colors.primary}
          cursorColor={theme.colors.primary}
          textAlignVertical="center"
          style={{
            color: theme.colors.text,
            fontSize: 15,
            fontWeight: '500',
            outlineColor: 'transparent',
            outlineWidth: 0,
            paddingVertical: 12,
            flex: 1,
          }}
          {...props}
        />
        {trailingIcon}
      </View>
    </View>
  );
}

/**
 * `tone` defaults to danger because all but one caller is a sign-in failure.
 * The exception is the redirect notice, which explains why the person is on
 * this screen: painting that red would contradict copy written to say nothing
 * went wrong, and announcing it assertively would interrupt a screen reader
 * for something that is not an alert.
 */
function InlineNotice({ title, body, tone = 'danger' }: {
  title: string;
  body: string;
  tone?: 'danger' | 'info';
}) {
  const theme = useAppTheme();
  const palette = tone === 'info' ? theme.semantic.info : theme.semantic.danger;
  return (
    <View
      accessibilityRole={tone === 'info' ? 'summary' : 'alert'}
      accessibilityLiveRegion={tone === 'info' ? 'polite' : 'assertive'}
      style={{
        borderRadius: appTheme.radii.md,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        padding: 12,
        gap: 5,
      }}
    >
      <Text selectable style={{ color: palette.foreground, fontSize: 14, lineHeight: 20, fontWeight: '700' }}>
        {title}
      </Text>
      <Text selectable style={{ color: theme.colors.muted, fontSize: 14, lineHeight: 19, fontWeight: '400' }}>
        {body}
      </Text>
    </View>
  );
}
