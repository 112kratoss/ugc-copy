import { router, useLocalSearchParams } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Eye, EyeOff, LockKeyhole, Mail, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { BrandLockup, PrimaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  describePasswordSignInError,
  describeProviderSignInError,
  validateCredentials,
  type AuthNotice,
} from '@/lib/auth-error-copy';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { completeAuthScreen, leaveAuthScreen } from '@/lib/auth-navigation';
import { env } from '@/lib/env';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { appTheme } from '@/lib/theme';
import googleSignInAndroid from '../assets/images/google-signin-android.png';

const workspace = {
  background: appTheme.colors.background,
  panel: appTheme.colors.panel,
  border: appTheme.colors.border,
  borderStrong: appTheme.colors.borderStrong,
  text: appTheme.colors.text,
  muted: appTheme.colors.muted,
  faint: appTheme.colors.faint,
  primary: appTheme.colors.primary,
  onPrimary: appTheme.colors.onPrimary,
};

/**
 * Sign in with Apple: "Make a Sign in with Apple button no smaller than other
 * sign-in buttons", and HIG Buttons: "Use style — not size — to visually
 * distinguish the preferred choice among multiple options … placing two buttons
 * of different sizes near each other can make the interface look confusing".
 * The third-party button therefore matches the screen's own primary button,
 * which is `PrimaryButton size="roomy"`.
 */
const THIRD_PARTY_BUTTON_HEIGHT = appTheme.touch.roomy;
/** The shared primary button is a pill, so the Apple button is given the same radius. */
const THIRD_PARTY_BUTTON_RADIUS = THIRD_PARTY_BUTTON_HEIGHT / 2;
/** Google's asset is 216×48; scaled on its own aspect so it is not distorted. */
const GOOGLE_BUTTON_ASPECT = 216 / 48;

export default function AuthScreen() {
  const { returnTo, mode: requestedMode } = useLocalSearchParams<{
    returnTo?: string | string[];
    mode?: string | string[];
  }>();
  const { user, signInWithPassword, signInWithApple, signInWithGoogle, isAuthConfigured, missingEnvKeys } = useAuth();
  const initialMode = (Array.isArray(requestedMode) ? requestedMode[0] : requestedMode) === 'signup'
    ? 'signup'
    : 'login';
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleSubmitting, setIsAppleSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isCompact = width < 390 || height < 820;
  // Deliberately not a validity gate. A button that is disabled for a reason it
  // cannot state leaves people guessing (the old gate wanted six characters and
  // said so only in a placeholder that vanished on the first keystroke); the
  // shape of what was typed is checked on submit instead, where it can be named.
  const canSubmit = mode === 'login'
    && isAuthConfigured
    && email.trim().length > 0
    && password.length > 0;
  const hasCompletedAuth = useRef(false);

  const finishAuth = useCallback(() => {
    if (hasCompletedAuth.current) {
      return;
    }

    hasCompletedAuth.current = true;
    completeAuthScreen(router, returnTo);
  }, [returnTo]);

  useEffect(() => {
    if (user) {
      finishAuth();
    }
  }, [finishAuth, user]);

  const submit = async () => {
    if (mode !== 'login') return;

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
      setNotice(describePasswordSignInError(nextError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const signInWithNativeApple = async () => {
    setIsAppleSubmitting(true);
    setNotice(null);
    try {
      await signInWithApple(mode);
      finishAuth();
    } catch (nextError) {
      if (!isAppleAuthCanceled(nextError)) {
        setNotice(describeProviderSignInError(nextError, 'Apple'));
      }
    } finally {
      setIsAppleSubmitting(false);
    }
  };

  const signInWithNativeGoogle = async () => {
    setIsGoogleSubmitting(true);
    setNotice(null);
    try {
      await signInWithGoogle();
      finishAuth();
    } catch (nextError) {
      if (!isGoogleAuthCanceled(nextError)) {
        setNotice(describeProviderSignInError(nextError, 'Google'));
      }
    } finally {
      setIsGoogleSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: workspace.background }}>
      <KeyboardAvoidingArea iosScrollViewAdjustsInsets>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: isCompact ? 16 : 20,
          paddingTop: Math.max(insets.top, 16) + 14,
          paddingBottom: Math.max(insets.bottom, 16) + 22,
          gap: isCompact ? 14 : 16,
        }}
      >
        <View style={{ width: '100%', maxWidth: 430, alignSelf: 'center', flex: 1, gap: isCompact ? 14 : 16 }}>
          <AuthHeader />

          <AuthPanel
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              setNotice(null);
            }}
            email={email}
            password={password}
            showPassword={showPassword}
            onEmailChange={(value) => {
              setEmail(value);
              setNotice(null);
            }}
            onPasswordChange={(value) => {
              setPassword(value);
              setNotice(null);
            }}
            onTogglePassword={() => setShowPassword((current) => !current)}
            onSubmit={submit}
            onAppleSignIn={signInWithNativeApple}
            onGoogleSignIn={signInWithNativeGoogle}
            canSubmit={canSubmit}
            isSubmitting={isSubmitting}
            isAppleSubmitting={isAppleSubmitting}
            isGoogleSubmitting={isGoogleSubmitting}
            isAuthConfigured={isAuthConfigured}
            missingEnvKeys={missingEnvKeys}
            notice={notice}
            showAppleSignIn={Platform.OS === 'ios'}
            showGoogleSignIn={Platform.OS === 'android'}
          />
        </View>
      </ScrollView>
      </KeyboardAvoidingArea>
    </View>
  );
}

function AuthHeader() {
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={() => leaveAuthScreen(router)}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: appTheme.colors.panelSoft,
          opacity: pressed ? 0.74 : 1,
        })}
      >
        <CloseGlyph size={appTheme.icon.feature} color={workspace.text} />
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' }}>
        <BrandLockup />
      </View>
      <View style={{ width: 48, height: 48 }} />
    </View>
  );
}

/**
 * Managing accounts: "Explain the benefits of creating an account and how to
 * sign up … Display this message in your sign-in view." One sentence carries
 * both, and names the method that is actually on screen — Managing accounts
 * again: "Refer only to authentication methods that are available in the
 * current context."
 */
function signUpSubtitle(showAppleSignIn: boolean, showGoogleSignIn: boolean) {
  if (showAppleSignIn) return 'Start saving generations, unlocks, and profile work. New accounts are created with Apple.';
  if (showGoogleSignIn) return 'Start saving generations, unlocks, and profile work. New accounts are created with Google.';
  return 'Start saving generations, unlocks, and profile work. New accounts are created with Apple or Google on a mobile device.';
}

function AuthPanel({
  mode,
  onModeChange,
  email,
  password,
  showPassword,
  onEmailChange,
  onPasswordChange,
  onTogglePassword,
  onSubmit,
  onAppleSignIn,
  onGoogleSignIn,
  canSubmit,
  isSubmitting,
  isAppleSubmitting,
  isGoogleSubmitting,
  isAuthConfigured,
  missingEnvKeys,
  notice,
  showAppleSignIn,
  showGoogleSignIn,
}: {
  mode: 'login' | 'signup';
  onModeChange: (mode: 'login' | 'signup') => void;
  email: string;
  password: string;
  showPassword: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTogglePassword: () => void;
  onSubmit: () => void;
  onAppleSignIn: () => void;
  onGoogleSignIn: () => void;
  canSubmit: boolean;
  isSubmitting: boolean;
  isAppleSubmitting: boolean;
  isGoogleSubmitting: boolean;
  isAuthConfigured: boolean;
  missingEnvKeys: string[];
  notice: AuthNotice | null;
  showAppleSignIn: boolean;
  showGoogleSignIn: boolean;
}) {
  const passwordRef = useRef<TextInput | null>(null);

  return (
    <View
      style={{
        borderRadius: appTheme.radii.xl,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: workspace.border,
        backgroundColor: workspace.panel,
        padding: 18,
        gap: 16,
      }}
    >
      <View style={{ gap: 5 }}>
        <Text accessibilityRole="header" selectable style={{ color: workspace.text, fontSize: 25, lineHeight: 31, fontWeight: '700' }}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </Text>
        <Text selectable style={{ color: workspace.muted, fontSize: 14, lineHeight: 21, fontWeight: '400' }}>
          {mode === 'login'
            ? 'Open your workspace and continue creating.'
            : signUpSubtitle(showAppleSignIn, showGoogleSignIn)}
        </Text>
      </View>

      <ModeTabs mode={mode} onChange={onModeChange} />

      {!isAuthConfigured ? (
        <InlineNotice
          title="Mobile auth is not configured"
          body={`Add ${missingEnvKeys.join(', ')} to ugc-mobile/.env.local and restart Expo.`}
        />
      ) : null}

      {mode === 'login' ? (
        <View style={{ gap: 10 }}>
          <WorkspaceInput
            label="Email"
            icon={<Mail size={appTheme.icon.compact} color={workspace.primary} />}
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
            onChangeText={onEmailChange}
            placeholder="you@example.com"
            trailingIcon={email.length > 0 ? (
              // Text fields, iOS: "Display a Clear button in the trailing end of
              // a text field to help people erase their input." Drawn rather
              // than left to `clearButtonMode`, which is iOS-only — this is the
              // same control on both platforms.
              <FieldButton label="Clear email" onPress={() => onEmailChange('')}>
                <X size={appTheme.icon.compact} color={workspace.muted} />
              </FieldButton>
            ) : null}
          />
          <WorkspaceInput
            label="Password"
            inputRef={passwordRef}
            icon={<LockKeyhole size={appTheme.icon.compact} color={workspace.primary} />}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (canSubmit) onSubmit?.();
            }}
            value={password}
            onChangeText={onPasswordChange}
            placeholder="Your password"
            trailingIcon={
              <FieldButton
                label={showPassword ? 'Hide password' : 'Show password'}
                onPress={onTogglePassword}
              >
                {/* Two glyphs, not one glyph in two colours — HIG Color: "avoid
                    relying solely on color to … communicate essential
                    information", the rule S13 applied to the profile grid. */}
                {showPassword
                  ? <EyeOff size={appTheme.icon.compact} color={workspace.primary} />
                  : <Eye size={appTheme.icon.compact} color={workspace.muted} />}
              </FieldButton>
            }
          />
        </View>
      ) : null}

      {/* Inside the panel and above the action, so it survives the keyboard: the
          password field's Return key is "go", which submits with the keyboard
          up, and the old toast was pinned to the bottom of the screen behind it. */}
      {notice ? <InlineNotice title={notice.title} body={notice.body} /> : null}

      {mode === 'login' ? (
        <PrimaryButton
          label="Sign in"
          loadingLabel="Signing in…"
          size="roomy"
          onPress={onSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
        />
      ) : null}

      {showAppleSignIn ? (
        <>
          {/* The divider offers an alternative, so it only appears where there is
              something to be an alternative to. In sign-up there is one way in. */}
          {mode === 'login' ? <OrContinueWith /> : null}
          <View
            pointerEvents={!isAuthConfigured || isAppleSubmitting ? 'none' : 'auto'}
            style={{ opacity: !isAuthConfigured || isAppleSubmitting ? appTheme.opacity.disabled : 1 }}
          >
            <AppleAuthentication.AppleAuthenticationButton
              accessibilityLabel={mode === 'signup' ? 'Sign up with Apple' : 'Sign in with Apple'}
              buttonType={mode === 'signup'
                ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
                : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={THIRD_PARTY_BUTTON_RADIUS}
              onPress={onAppleSignIn}
              style={{ width: '100%', height: THIRD_PARTY_BUTTON_HEIGHT }}
            />
          </View>
        </>
      ) : null}

      {showGoogleSignIn ? (
        <>
          {mode === 'login' ? <OrContinueWith /> : null}
          <Pressable
            accessibilityRole="button"
            // Google ships one asset, and it reads "Sign in with Google" in both
            // modes — Google's branding covers sign-up with the same button.
            // The spoken name therefore matches the drawn one (a name that
            // said "Sign up…" over artwork saying "Sign in…" is a control
            // Voice Control cannot be asked for); the mode goes in the hint.
            accessibilityLabel="Sign in with Google"
            accessibilityHint={mode === 'signup'
              ? 'Creates your account with Google and returns to Magicbooklet'
              : 'Opens Google authentication and returns to Magicbooklet'}
            accessibilityState={{ busy: isGoogleSubmitting, disabled: !isAuthConfigured || isGoogleSubmitting }}
            disabled={!isAuthConfigured || isGoogleSubmitting}
            onPress={onGoogleSignIn}
            style={({ pressed }) => ({
              minHeight: THIRD_PARTY_BUTTON_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !isAuthConfigured || isGoogleSubmitting ? appTheme.opacity.disabled : pressed ? 0.78 : 1,
            })}
          >
            {isGoogleSubmitting ? (
              <ActivityIndicator color={workspace.text} />
            ) : (
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="contain"
                source={googleSignInAndroid}
                style={{
                  width: THIRD_PARTY_BUTTON_HEIGHT * GOOGLE_BUTTON_ASPECT,
                  height: THIRD_PARTY_BUTTON_HEIGHT,
                }}
              />
            )}
          </Pressable>
        </>
      ) : null}

      <View style={{ alignItems: 'center', gap: 6 }}>
        <Text style={{ color: workspace.faint, fontSize: 11, lineHeight: 17, textAlign: 'center' }}>
          By continuing, you agree to the Magicbooklet terms and acknowledge the privacy policy.
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open privacy policy"
            onPress={() => void Linking.openURL(`${env.siteUrl}/privacy`)}
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: workspace.primary, fontSize: 12, fontWeight: '700' }}>Privacy Policy</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open terms of service"
            onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
          >
            <Text style={{ color: workspace.primary, fontSize: 12, fontWeight: '700' }}>Terms of Service</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function OrContinueWith() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
      <Text style={{ color: workspace.faint, fontSize: 12, fontWeight: '600' }}>or continue with</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
    </View>
  );
}

/**
 * The app's segmented control, as `ProfileSegment` and `CreatorHeader` already
 * draw it: `role="tab"`, a solid fill on the selected item and a dark label on
 * it. This screen used to invent its own — a tinted fill with a coloured
 * border — which is the Familiarity rule ("once you establish a behavior or
 * appearance for an element, apply it throughout") broken on the front door.
 */
function ModeTabs({ mode, onChange }: { mode: 'login' | 'signup'; onChange: (mode: 'login' | 'signup') => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, padding: 4, borderRadius: 18, backgroundColor: appTheme.colors.surfaceInset, borderWidth: 1, borderColor: workspace.border }}>
      {(['login', 'signup'] as const).map((item) => {
        const active = item === mode;
        return (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityLabel={item === 'login' ? 'Switch to sign in' : 'Switch to sign up'}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(item)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: appTheme.touch.compact,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? workspace.primary : 'transparent',
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <Text numberOfLines={1} style={{ color: active ? workspace.onPrimary : workspace.muted, fontSize: 13, fontWeight: '700' }}>
              {item === 'login' ? 'Sign in' : 'Sign up'}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <Text style={{ color: appTheme.colors.textSecondary, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <View
        style={{
          minHeight: 56,
          borderRadius: 18,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: workspace.borderStrong,
          backgroundColor: appTheme.colors.surfaceInset,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 13,
          paddingRight: trailingIcon ? 6 : 14,
          gap: 10,
        }}
      >
        <View style={{ width: 32, height: 32, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.pressed }}>
          {icon}
        </View>
        <TextInput
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={workspace.faint}
          selectionColor={workspace.primary}
          cursorColor={workspace.primary}
          textAlignVertical="center"
          style={{
            color: workspace.text,
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

function InlineNotice({ title, body }: { title: string; body: string }) {
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.semantic.danger.border,
        backgroundColor: appTheme.semantic.danger.background,
        padding: 12,
        gap: 5,
      }}
    >
      <Text selectable style={{ color: appTheme.colors.danger, fontSize: 14, lineHeight: 20, fontWeight: '700' }}>
        {title}
      </Text>
      <Text selectable style={{ color: workspace.muted, fontSize: 14, lineHeight: 19, fontWeight: '400' }}>
        {body}
      </Text>
    </View>
  );
}
