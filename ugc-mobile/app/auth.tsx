import { router, useLocalSearchParams } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import { ActivityIndicator, Image, Linking, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCircle, Eye, LockKeyhole, Mail, Sparkles, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { useAuth } from '@/lib/auth';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { completeAuthScreen, leaveAuthScreen } from '@/lib/auth-navigation';
import { env } from '@/lib/env';
import { BackGlyph } from '@/lib/platform-glyphs';
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
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleSubmitting, setIsAppleSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isCompact = width < 390 || height < 820;
  const canSubmit = mode === 'login'
    && isAuthConfigured
    && email.trim().length > 0
    && password.length >= 6;
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
    setIsSubmitting(true);
    setError(null);
    try {
      await signInWithPassword(email.trim(), password);
      finishAuth();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const signInWithNativeApple = async () => {
    setIsAppleSubmitting(true);
    setError(null);
    try {
      await signInWithApple(mode);
      finishAuth();
    } catch (nextError) {
      if (!isAppleAuthCanceled(nextError)) {
        setError(nextError instanceof Error ? nextError.message : 'Apple sign-in failed.');
      }
    } finally {
      setIsAppleSubmitting(false);
    }
  };

  const signInWithNativeGoogle = async () => {
    setIsGoogleSubmitting(true);
    setError(null);
    try {
      await signInWithGoogle();
      finishAuth();
    } catch (nextError) {
      if (!isGoogleAuthCanceled(nextError)) {
        setError(nextError instanceof Error ? nextError.message : 'Google sign-in failed.');
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
              setError(null);
            }}
            email={email}
            password={password}
            showPassword={showPassword}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
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
            showAppleSignIn={Platform.OS === 'ios'}
            showGoogleSignIn={Platform.OS === 'android'}
          />
        </View>
      </ScrollView>
      </KeyboardAvoidingArea>

      {error ? <ErrorToast message={error} bottomInset={insets.bottom} onDismiss={() => setError(null)} /> : null}
    </View>
  );
}

function AuthHeader() {
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to app"
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
        <BackGlyph size={appTheme.icon.feature} color={workspace.text} />
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 7 }}>
        <Sparkles size={22} color={workspace.primary} />
        <Text numberOfLines={1} style={{ color: workspace.text, fontSize: 19, fontWeight: '700' }}>Magicbooklet</Text>
      </View>
      <View style={{ width: 48, height: 48 }} />
    </View>
  );
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
          {mode === 'login' ? 'Open your workspace and continue creating.' : 'Start saving generations, unlocks, and profile work.'}
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
        <>
          <View style={{ gap: 10 }}>
            <WorkspaceInput
              icon={<Mail size={19} color={workspace.primary} />}
              accessibilityLabel="Email"
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
            />
            <WorkspaceInput
              inputRef={passwordRef}
              icon={<LockKeyhole size={19} color={workspace.primary} />}
              accessibilityLabel="Password"
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
              placeholder="Minimum 6 characters"
              trailingIcon={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  onPress={onTogglePassword}
                  hitSlop={10}
                  style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
                >
                  <Eye size={18} color={showPassword ? workspace.primary : workspace.muted} />
                </Pressable>
              }
            />
          </View>

          <PrimaryButton
            label="Sign in"
            onPress={onSubmit}
            disabled={!canSubmit}
            loading={isSubmitting}
          />
        </>
      ) : (
        <InlineNotice
          title="Choose a secure sign-up option"
          body={showAppleSignIn
            ? 'New accounts use Sign in with Apple. Existing email accounts can still sign in from the Sign in tab.'
            : showGoogleSignIn
              ? 'New accounts use Sign in with Google. Existing email accounts can still sign in from the Sign in tab.'
              : 'Create your account with Apple or Google on a supported mobile device. Existing email accounts can still sign in.'}
        />
      )}

      {showAppleSignIn ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
            <Text style={{ color: workspace.faint, fontSize: 12, fontWeight: '600' }}>or continue with</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
          </View>
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
              cornerRadius={17}
              onPress={onAppleSignIn}
              style={{ width: '100%', height: 48 }}
            />
          </View>
        </>
      ) : null}

      {showGoogleSignIn ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
            <Text style={{ color: workspace.faint, fontSize: 12, fontWeight: '600' }}>or continue with</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === 'signup' ? 'Sign up with Google' : 'Sign in with Google'}
            accessibilityHint="Opens Google authentication and returns to Magicbooklet"
            accessibilityState={{ busy: isGoogleSubmitting, disabled: !isAuthConfigured || isGoogleSubmitting }}
            disabled={!isAuthConfigured || isGoogleSubmitting}
            onPress={onGoogleSignIn}
            style={({ pressed }) => ({
              minHeight: 48,
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
                style={{ width: 216, height: 48 }}
              />
            )}
          </Pressable>
        </>
      ) : null}

      <View style={{ alignItems: 'center', gap: 9 }}>
        <Pressable
          onPress={() => onModeChange(mode === 'login' ? 'signup' : 'login')}
          style={({ pressed }) => ({ opacity: pressed ? 0.68 : 1 })}
        >
          <Text style={{ color: workspace.muted, fontSize: 14, fontWeight: '800' }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <Text style={{ color: workspace.primary, fontWeight: '700' }}>{mode === 'login' ? 'Sign up' : 'Sign in'}</Text>
          </Text>
        </Pressable>
      </View>

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

function ModeTabs({ mode, onChange }: { mode: 'login' | 'signup'; onChange: (mode: 'login' | 'signup') => void }) {
  return (
    <View style={{ flexDirection: 'row', padding: 3, borderRadius: 19, backgroundColor: appTheme.colors.surfaceInset, borderWidth: 1, borderColor: workspace.border }}>
      {(['login', 'signup'] as const).map((item) => {
        const active = item === mode;
        return (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityLabel={item === 'login' ? 'Switch to sign in' : 'Switch to sign up'}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(item)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? appTheme.colors.selectedStrong : 'transparent',
              borderWidth: 1,
              borderColor: active ? workspace.primary : 'transparent',
              opacity: pressed ? 0.72 : 1,
            })}
          >
            <Text style={{ color: active ? workspace.text : workspace.muted, fontSize: 13, fontWeight: '700' }}>
              {item === 'login' ? 'Sign in' : 'Sign up'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function WorkspaceInput({
  icon,
  trailingIcon,
  inputRef,
  ...props
}: TextInputProps & {
  icon: React.ReactNode;
  trailingIcon?: React.ReactNode;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  return (
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
        paddingRight: trailingIcon ? 12 : 14,
        gap: 10,
      }}
    >
      <View style={{ width: 32, height: 32, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.pressed }}>
        {icon}
      </View>
      <TextInput
        ref={inputRef}
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
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(loading) }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 9,
        backgroundColor: disabled ? appTheme.colors.panelSoft : pressed ? appTheme.colors.primaryStrong : workspace.primary,
        opacity: disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={workspace.onPrimary} />
      ) : (
        <Text style={{ color: disabled ? workspace.faint : workspace.onPrimary, fontSize: 16, fontWeight: '700' }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function InlineNotice({ title, body }: { title: string; body: string }) {
  return (
    <View
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
      <Text selectable style={{ color: appTheme.colors.danger, fontSize: 14, fontWeight: '700' }}>
        {title}
      </Text>
      <Text selectable style={{ color: workspace.muted, lineHeight: 19, fontWeight: '400' }}>
        {body}
      </Text>
    </View>
  );
}

function ErrorToast({
  message,
  bottomInset,
  onDismiss,
}: {
  message: string;
  bottomInset: number;
  onDismiss: () => void;
}) {
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        position: 'absolute',
        left: 18,
        right: 18,
        bottom: Math.max(bottomInset, 14) + 14,
        borderRadius: 22,
        borderCurve: 'continuous',
        backgroundColor: appTheme.colors.panel,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: appTheme.semantic.danger.border,
        boxShadow: '0 16px 36px rgba(0,0,0,0.38)',
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: appTheme.semantic.danger.background,
        }}
      >
        <AlertCircle size={18} color={appTheme.colors.danger} />
      </View>
      <Text selectable numberOfLines={2} style={{ flex: 1, color: workspace.text, fontSize: 13, lineHeight: 18, fontWeight: '800' }}>
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
        onPress={onDismiss}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)',
        })}
      >
        <X size={18} color={workspace.text} />
      </Pressable>
    </View>
  );
}
