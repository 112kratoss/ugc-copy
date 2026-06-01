import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { AppTextInput, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { leaveAuthScreen } from '@/lib/auth-navigation';
import { appTheme } from '@/lib/theme';

export default function AuthScreen() {
  const { signInWithPassword, signUpWithPassword, isAuthConfigured, missingEnvKeys } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (mode === 'login') {
        await signInWithPassword(email.trim(), password);
      } else {
        await signUpWithPassword(email.trim(), password);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="magicbooklet"
        title={mode === 'login' ? 'Welcome back.' : 'Create your creator account.'}
        body="Sign in to manage credits, create AI media, publish posts, and unlock reusable creator resources."
      />

      <View style={{ gap: 14 }}>
        {!isAuthConfigured ? (
          <StatusBlock
            tone="danger"
            title="Mobile auth is not configured"
            body={`Add ${missingEnvKeys.join(', ')} to ugc-mobile/.env.local and restart Expo.`}
          />
        ) : null}
        <AppTextInput
          label="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
        />
        <AppTextInput
          label="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          placeholder="Minimum 6 characters"
        />
        {error ? <StatusBlock tone="danger" title="Could not sign in" body={error} /> : null}
        <PrimaryButton
          label={mode === 'login' ? 'Sign in' : 'Create account'}
          onPress={submit}
          loading={isSubmitting}
          disabled={!isAuthConfigured || !email || password.length < 6}
          accent="motion"
        />
        <SecondaryButton
          label={mode === 'login' ? 'Create a new account' : 'I already have an account'}
          onPress={() => setMode((current) => (current === 'login' ? 'signup' : 'login'))}
        />
        <SecondaryButton label="Back to app" onPress={() => leaveAuthScreen(router)} />
      </View>

      <Text selectable style={{ color: appTheme.colors.faint, lineHeight: 20 }}>
        Google and other OAuth providers can be wired to Supabase native deep links after the app bundle IDs are registered.
      </Text>
    </Screen>
  );
}
