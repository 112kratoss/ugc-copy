// The email half of the sign-in page (`components/sign-in-wall.tsx`), drawn in place over its
// wall when "Sign in with email" is chosen.
import { Eye, EyeOff, X } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { BUTTON_HEIGHT, BUTTON_LABEL_SIZE, BUTTON_MAX_WIDTH, SignInProviderButtons, SignInTerms } from '@/components/sign-in-parts';
import type { RunSignIn, SignInMethod } from '@/components/sign-in-wall';
import { AppText, BrandLockup, IconButton } from '@/components/ui';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { useAuth } from '@/lib/auth';
import {
  SIGN_IN_SUPPORT,
  SIGN_IN_SUPPORT_MAIL_URL,
  describePasswordSignInError,
  describeProviderSignInError,
  signInProviderButtons,
  validateCredentials,
  type AuthNotice,
} from '@/lib/auth-error-copy';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { useSignInPageNotice } from '@/lib/sign-in-page-notice';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';


/**
 * The email form (owner, 2026-11-08), the sign-in page's second half: the page turns into it in
 * place, over the same moving wall ("instead of going to another page … a smooth transition into
 * the sign in section … keep the background moving too"). Email signs into an account made with
 * email; it makes none, so there are no Sign in / Sign up tabs. Apple and Google stay under it.
 */
export function EmailSignInForm({ initialNotice = null, inFlight, runSignIn, onBack }: {
  /** Why a redirect sent the person here, when the page opens on this form. */
  initialNotice?: AuthNotice | null;
  /** The page's sign-in under way, from either half; while one runs, this form waits. */
  inFlight: SignInMethod | null;
  /** The page runs every sign-in: one at a time, counted once, and moved on from once. */
  runSignIn: RunSignIn;
  /** Back to the page's first choices. */
  onBack: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { signInWithPassword, signInWithApple, signInWithGoogle, isAuthConfigured, missingEnvKeys } = useAuth();
  // The buttons the sign-in page draws on this platform, and so the only ones the copy may name.
  const providerButtons = signInProviderButtons(Platform.OS);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Seeded from the route so a redirect can say why it sent the person here.
  // Only a known key maps to copy; an unrecognised one shows nothing rather
  // than letting a deep link put arbitrary text on the sign-in screen.
  const [notice, setNotice] = useSignInPageNotice(initialNotice);
  const isSubmitting = inFlight === 'email';
  const isSignInInFlight = inFlight !== null;
  const passwordRef = useRef<TextInput | null>(null);
  // Deliberately not a validity gate. A button that is disabled for a reason it
  // cannot state leaves people guessing (the old gate wanted six characters and
  // said so only in a placeholder that vanished on the first keystroke); the
  // shape of what was typed is checked on submit instead, where it can be named.
  const canSubmit = isAuthConfigured && !isSignInInFlight && email.trim().length > 0 && password.length > 0;

  const continueWithApple = async () => {
    setNotice(null);
    try {
      await runSignIn('apple', () => signInWithApple('signup'));
    } catch (nextError) {
      if (!isAppleAuthCanceled(nextError)) setNotice(describeProviderSignInError(nextError, 'Apple'));
    }
  };

  const continueWithGoogle = async () => {
    setNotice(null);
    try {
      await runSignIn('google', () => signInWithGoogle());
    } catch (nextError) {
      if (!isGoogleAuthCanceled(nextError)) setNotice(describeProviderSignInError(nextError, 'Google'));
    }
  };

  const submit = async () => {
    if (isSignInInFlight) return;
    const invalid = validateCredentials(email, password);
    if (invalid) {
      setNotice(invalid);
      return;
    }
    setNotice(null);
    try {
      await runSignIn('email', () => signInWithPassword(email.trim(), password));
    } catch (nextError) {
      setNotice(describePasswordSignInError(nextError, { providerButtons }));
    }
  };

  return (
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
            label="Back to all sign-in options"
            variant="plain"
            // Not while a sign-in is under way: it lands on this page, which must still be here.
            disabled={isSignInInFlight}
            onPress={onBack}
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

            {/* Coral, the app's own action colour, so this page's one action stands apart from
                Apple and Google below, which Apple's rules keep white on dark. */}
            {/* On solid black, so the faded state reads as a dimmed button, not as the wall
                showing through it. */}
            {/* The buttons share one compact, centred width (components/sign-in-parts.tsx). */}
            <View style={{ width: '100%', maxWidth: BUTTON_MAX_WIDTH, alignSelf: 'center', gap: 12, marginTop: 4 }}>
            <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: mediaColors.mediaGround }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isSubmitting ? 'Signing in…' : 'Sign in'}
              accessibilityState={{ disabled: !canSubmit, busy: isSubmitting }}
              disabled={!canSubmit}
              onPress={() => void submit()}
              style={({ pressed }) => ({
                height: BUTTON_HEIGHT,
                borderRadius: appTheme.radii.pill,
                backgroundColor: pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: !canSubmit && !isSubmitting ? appTheme.opacity.disabled : 1,
              })}
            >
              {isSubmitting ? <ActivityIndicator color={theme.colors.onPrimary} /> : null}
              <Text style={{ color: theme.colors.onPrimary, fontSize: BUTTON_LABEL_SIZE, fontWeight: '600', letterSpacing: -0.2 }}>
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Text>
            </Pressable>
            </View>

            {/* For an account made with Apple or Google, which the wrong-password copy points
                at, and for anyone who reached email by mistake: the X leaves sign-in. */}
            <OrDivider />
            <SignInProviderButtons
              onApple={() => void continueWithApple()}
              onGoogle={() => void continueWithGoogle()}
              appleBusy={inFlight === 'apple'}
              googleBusy={inFlight === 'google'}
              unavailable={!isAuthConfigured || isSignInInFlight}
            />
            </View>
          </View>

          <View style={{ flex: 1, minHeight: 24 }} />
          <SignInTerms />
        </View>
      </ScrollView>
      </KeyboardAvoidingArea>
  );
}

/** "or", between the email form and Apple and Google. */
function OrDivider() {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 2 }}>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: theme.colors.borderStrong }} />
      <Text style={{ color: mediaColors.onMediaSecondary, fontSize: 13, fontWeight: '600' }}>or</Text>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: theme.colors.borderStrong }} />
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

/** The sign-in page's labelled pill field, also drawn by its invite-code field (`sign-in-wall.tsx`). */
export function WorkspaceInput({
  label,
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
  trailingIcon?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      {/* In line with the text inside the pill below it. */}
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', paddingLeft: 22 }}>
        {label}
      </Text>
      <View
        style={{
          // A pill, as the page's buttons are (owner, 2026-11-08: "round as the button for
          // consistency").
          minHeight: 52,
          borderRadius: appTheme.radii.pill,
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          backgroundColor: theme.colors.surfaceInset,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 22,
          paddingRight: trailingIcon ? 8 : 20,
          gap: 10,
        }}
      >
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
