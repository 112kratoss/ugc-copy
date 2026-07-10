import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { AlertCircle, Apple, ArrowLeft, Eye, LockKeyhole, Mail, Sparkles, WandSparkles, X } from 'lucide-react-native';
import { useState } from 'react';

import { useAuth } from '@/lib/auth';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import { completeAuthScreen, leaveAuthScreen } from '@/lib/auth-navigation';

const workspace = {
  background: '#03040d',
  panel: 'rgba(15,16,24,0.86)',
  border: 'rgba(255,255,255,0.12)',
  borderStrong: 'rgba(255,255,255,0.18)',
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.66)',
  faint: 'rgba(255,255,255,0.44)',
  blue: '#2563eb',
};

export default function AuthScreen() {
  const { returnTo } = useLocalSearchParams<{ returnTo?: string | string[] }>();
  const { signInWithPassword, signUpWithPassword, signInWithApple, isAuthConfigured, missingEnvKeys } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppleSubmitting, setIsAppleSubmitting] = useState(false);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isCompact = width < 390 || height < 820;
  const canSubmit = isAuthConfigured && email.trim().length > 0 && password.length >= 6;

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (mode === 'login') {
        await signInWithPassword(email.trim(), password);
      } else {
        await signUpWithPassword(email.trim(), password);
      }
      completeAuthScreen(router, returnTo);
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
      completeAuthScreen(router, returnTo);
    } catch (nextError) {
      if (!isAppleAuthCanceled(nextError)) {
        setError(nextError instanceof Error ? nextError.message : 'Apple sign-in failed.');
      }
    } finally {
      setIsAppleSubmitting(false);
    }
  };

  const showOAuthNotice = () => {
    setError('Google sign-in can be wired after the native deep links are registered.');
  };

  return (
    <View style={{ flex: 1, backgroundColor: workspace.background }}>
      <Stack.Screen options={{ headerShown: false, contentStyle: { backgroundColor: workspace.background } }} />
      <WorkspaceBackdrop />

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
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
            onOAuthNotice={showOAuthNotice}
            onAppleSignIn={signInWithNativeApple}
            onForgotPassword={() => setError('Password reset can be connected after Supabase deep links are registered.')}
            onBack={() => leaveAuthScreen(router)}
            canSubmit={canSubmit}
            isSubmitting={isSubmitting}
            isAppleSubmitting={isAppleSubmitting}
            isAuthConfigured={isAuthConfigured}
            missingEnvKeys={missingEnvKeys}
            showAppleSignIn={Platform.OS === 'ios'}
          />
        </View>
      </ScrollView>

      {error ? <ErrorToast message={error} bottomInset={insets.bottom} onDismiss={() => setError(null)} /> : null}
    </View>
  );
}

function AuthHeader() {
  return (
    <View style={{ minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to app"
        onPress={() => leaveAuthScreen(router)}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.07)',
          opacity: pressed ? 0.74 : 1,
        })}
      >
        <ArrowLeft size={21} color="#ffffff" />
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 7 }}>
        <Sparkles size={22} color="#c084fc" fill="rgba(192,132,252,0.18)" />
        <Text numberOfLines={1} style={{ color: workspace.text, fontSize: 19, fontWeight: '900' }}>Magicbooklet</Text>
      </View>
      <View style={{ width: 40, height: 40 }} />
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
  onOAuthNotice,
  onAppleSignIn,
  onForgotPassword,
  onBack,
  canSubmit,
  isSubmitting,
  isAppleSubmitting,
  isAuthConfigured,
  missingEnvKeys,
  showAppleSignIn,
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
  onOAuthNotice: () => void;
  onAppleSignIn: () => void;
  onForgotPassword: () => void;
  onBack: () => void;
  canSubmit: boolean;
  isSubmitting: boolean;
  isAppleSubmitting: boolean;
  isAuthConfigured: boolean;
  missingEnvKeys: string[];
  showAppleSignIn: boolean;
}) {
  return (
    <View
      style={{
        borderRadius: 28,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: workspace.border,
        backgroundColor: workspace.panel,
        padding: 16,
        gap: 14,
      }}
    >
      <View style={{ gap: 5 }}>
        <Text selectable style={{ color: workspace.text, fontSize: 24, fontWeight: '900' }}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </Text>
        <Text selectable style={{ color: workspace.muted, fontSize: 14, lineHeight: 20, fontWeight: '700' }}>
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

      <View style={{ gap: 10 }}>
        <WorkspaceInput
          icon={<Mail size={19} color="#c084fc" />}
          accessibilityLabel="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={onEmailChange}
          placeholder="you@example.com"
        />
        <WorkspaceInput
          icon={<LockKeyhole size={19} color="#c084fc" />}
          accessibilityLabel="Password"
          secureTextEntry={!showPassword}
          value={password}
          onChangeText={onPasswordChange}
          placeholder="Minimum 6 characters"
          trailingIcon={
            <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} onPress={onTogglePassword} hitSlop={10}>
              <Eye size={18} color={showPassword ? '#ffffff' : 'rgba(255,255,255,0.52)'} />
            </Pressable>
          }
        />
      </View>

      {mode === 'login' ? (
        <Pressable onPress={onForgotPassword} style={({ pressed }) => ({ alignSelf: 'flex-end', opacity: pressed ? 0.68 : 1, paddingVertical: 1 })}>
          <Text style={{ color: '#c084fc', fontSize: 13, fontWeight: '900' }}>Forgot password?</Text>
        </Pressable>
      ) : null}

      <PrimaryButton
        label={mode === 'login' ? 'Sign in' : 'Create account'}
        onPress={onSubmit}
        disabled={!canSubmit}
        loading={isSubmitting}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
        <Text style={{ color: workspace.faint, fontSize: 12, fontWeight: '800' }}>or continue with</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: workspace.border }} />
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <SocialButton label="Google" onPress={onOAuthNotice}>
          <GoogleGlyph />
        </SocialButton>
        {showAppleSignIn ? (
          <SocialButton
            label="Apple"
            onPress={onAppleSignIn}
            disabled={!isAuthConfigured || isAppleSubmitting}
            loading={isAppleSubmitting}
          >
            <Apple size={23} color="#ffffff" fill="#ffffff" strokeWidth={1.2} />
          </SocialButton>
        ) : null}
      </View>

      <View style={{ alignItems: 'center', gap: 9 }}>
        <Pressable
          onPress={() => onModeChange(mode === 'login' ? 'signup' : 'login')}
          style={({ pressed }) => ({ opacity: pressed ? 0.68 : 1 })}
        >
          <Text style={{ color: workspace.muted, fontSize: 14, fontWeight: '800' }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <Text style={{ color: '#c084fc', fontWeight: '900' }}>{mode === 'login' ? 'Sign up' : 'Sign in'}</Text>
          </Text>
        </Pressable>
        <Pressable onPress={onBack} style={({ pressed }) => ({ opacity: pressed ? 0.68 : 1, paddingVertical: 2 })}>
          <Text style={{ color: workspace.faint, fontSize: 12, fontWeight: '900' }}>Back to app</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ModeTabs({ mode, onChange }: { mode: 'login' | 'signup'; onChange: (mode: 'login' | 'signup') => void }) {
  return (
    <View style={{ flexDirection: 'row', padding: 3, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.06)' }}>
      {(['login', 'signup'] as const).map((item) => {
        const active = item === mode;
        return (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(item)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 38,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? 'rgba(168,85,247,0.54)' : 'transparent',
              opacity: pressed ? 0.72 : 1,
            })}
          >
            <Text style={{ color: active ? workspace.text : workspace.muted, fontSize: 13, fontWeight: '900' }}>
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
  ...props
}: TextInputProps & {
  icon: React.ReactNode;
  trailingIcon?: React.ReactNode;
}) {
  return (
    <View
      style={{
        minHeight: 54,
        borderRadius: 18,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: workspace.borderStrong,
        backgroundColor: 'rgba(3,4,13,0.58)',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 13,
        paddingRight: trailingIcon ? 12 : 14,
        gap: 10,
      }}
    >
      <View style={{ width: 30, height: 30, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(168,85,247,0.13)' }}>
        {icon}
      </View>
      <TextInput
        placeholderTextColor="rgba(255,255,255,0.38)"
        selectionColor="#c084fc"
        cursorColor="#c084fc"
        textAlignVertical="center"
        style={{
          color: workspace.text,
          fontSize: 15,
          fontWeight: '800',
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
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 54,
        borderRadius: 18,
        overflow: 'hidden',
        opacity: disabled ? 0.54 : pressed ? 0.86 : 1,
        transform: [{ scale: pressed && !disabled ? 0.99 : 1 }],
      })}
    >
      <LinearGradient
        colors={disabled ? ['rgba(82,82,91,0.7)', 'rgba(63,63,70,0.7)'] : [workspace.blue, '#d946ef']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ minHeight: 54, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 }}
      >
        {loading ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <>
            <WandSparkles size={19} color="#ffffff" />
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
              {label}
            </Text>
          </>
        )}
      </LinearGradient>
    </Pressable>
  );
}

function SocialButton({
  children,
  label,
  onPress,
  disabled,
  loading,
}: {
  children: React.ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 48,
        borderRadius: 17,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.07)',
        opacity: disabled ? 0.48 : pressed ? 0.76 : 1,
        borderWidth: 1,
        borderColor: workspace.border,
      })}
    >
      {loading ? <ActivityIndicator color="#ffffff" /> : children}
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
        borderColor: 'rgba(251,113,133,0.26)',
        backgroundColor: 'rgba(251,113,133,0.1)',
        padding: 12,
        gap: 5,
      }}
    >
      <Text selectable style={{ color: '#fecdd3', fontSize: 14, fontWeight: '900' }}>
        {title}
      </Text>
      <Text selectable style={{ color: workspace.muted, lineHeight: 19, fontWeight: '700' }}>
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
      style={{
        position: 'absolute',
        left: 18,
        right: 18,
        bottom: Math.max(bottomInset, 14) + 14,
        borderRadius: 22,
        borderCurve: 'continuous',
        backgroundColor: 'rgba(24,24,31,0.96)',
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderWidth: 1,
        borderColor: 'rgba(251,113,133,0.28)',
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
          backgroundColor: 'rgba(251,113,133,0.18)',
        }}
      >
        <AlertCircle size={18} color="#fecdd3" strokeWidth={2.8} />
      </View>
      <Text selectable numberOfLines={2} style={{ flex: 1, color: workspace.text, fontSize: 13, lineHeight: 18, fontWeight: '800' }}>
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss error"
        onPress={onDismiss}
        style={({ pressed }) => ({
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)',
        })}
      >
        <X size={16} color="#ffffff" strokeWidth={2.6} />
      </Pressable>
    </View>
  );
}

function GoogleGlyph() {
  return (
    <Svg width={24} height={24} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6 29.3 4 24 4C12.9 4 4 12.9 4 24s8.9 20 20 20s20-8.9 20-20c0-1.3-.1-2.5-.4-3.5Z" />
      <Path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6 29.3 4 24 4C16.2 4 9.5 8.5 6.3 14.7Z" />
      <Path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.8l-6.5 5C9.4 39.6 16.1 44 24 44Z" />
      <Path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C36.9 39.3 44 34 44 24c0-1.3-.1-2.5-.4-3.5Z" />
    </Svg>
  );
}

function WorkspaceBackdrop() {
  return (
    <View style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <LinearGradient
        colors={['#071026', '#090516', '#03040d']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: -120, top: -90, width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(37,99,235,0.2)' }} />
      <View style={{ position: 'absolute', right: -120, top: 70, width: 270, height: 270, borderRadius: 135, backgroundColor: 'rgba(217,70,239,0.16)' }} />
      <View style={{ position: 'absolute', left: -80, bottom: -120, width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(20,184,166,0.08)' }} />
    </View>
  );
}
