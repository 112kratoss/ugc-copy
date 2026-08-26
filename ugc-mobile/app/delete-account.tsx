import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';

import { AppText, AppTextInput, Card, PrimaryButton, SecondaryButton, SectionTitle, StatusBlock, Screen } from '@/components/ui';
import {
  isAccountReauthenticationRequired,
  useAuth,
  type AccountDeletionReauthentication,
} from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function DeleteAccountScreen() {
  const { accountReauthenticationMethods, deleteAccount, user } = useAuth();
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isConfirmed = confirmation.trim().toUpperCase() === 'DELETE';

  const removeAccount = async (reauthentication?: AccountDeletionReauthentication) => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteAccount(reauthentication);
      Alert.alert('Account deleted', 'Your Magic Booklet account and personal data were permanently deleted.');
    } catch (nextError) {
      if (isAccountReauthenticationRequired(nextError)) {
        setNeedsReauthentication(true);
        setIsDeleting(false);
        return;
      }
      setError(nextError instanceof Error ? nextError.message : 'Account deletion could not be completed.');
      setIsDeleting(false);
    }
  };

  return (
    <Screen keyboardAware>
      <SectionTitle
        eyebrow="Account"
        title="Delete your account"
        body="This permanently removes your Magic Booklet account. This action cannot be undone."
      />

      <Card style={{ borderColor: appTheme.semantic.danger.border }}>
        <AppText variant="cardTitle" color="danger">What will be deleted</AppText>
        <View style={{ gap: appTheme.spacing.compact }}>
          <AppText variant="bodySm" color="muted">• Your profile and sign-in credentials</AppText>
          <AppText variant="bodySm" color="muted">• Private creations, uploads, templates, and saved items</AppText>
          <AppText variant="bodySm" color="muted">• Remaining credits and purchase-linked account access</AppText>
        </View>
      </Card>

      {error ? (
        <StatusBlock
          tone="danger"
          title="Account was not deleted"
          body={`${error} Your account is still active; check your connection and try again.`}
        />
      ) : null}

      {needsReauthentication ? (
        <Card style={{ gap: appTheme.spacing.gap }}>
          <AppText variant="cardTitle">Confirm your identity</AppText>
          <AppText variant="bodySm" color="muted">
            Sign in again with the same account. After verification, deletion continues immediately.
          </AppText>

          {accountReauthenticationMethods.includes('password') ? (
            <View style={{ gap: appTheme.spacing.gap }}>
              <AppTextInput
                accessibilityLabel="Current password for account deletion"
                autoCapitalize="none"
                autoComplete="current-password"
                editable={!isDeleting}
                label="Current password"
                onChangeText={setCurrentPassword}
                onSubmitEditing={() => {
                  if (currentPassword) {
                    void removeAccount({ method: 'password', password: currentPassword });
                  }
                }}
                returnKeyType="done"
                secureTextEntry
                textContentType="password"
                value={currentPassword}
              />
              <PrimaryButton
                accent="danger"
                disabled={!currentPassword}
                label={isDeleting ? 'Verifying and deleting…' : 'Verify password and delete'}
                loading={isDeleting}
                onPress={() => void removeAccount({ method: 'password', password: currentPassword })}
              />
            </View>
          ) : null}

          {accountReauthenticationMethods.includes('google') ? (
            <SecondaryButton
              disabled={isDeleting}
              label={isDeleting ? 'Verifying…' : 'Continue with Google and delete'}
              onPress={() => void removeAccount({ method: 'google' })}
            />
          ) : null}

          {accountReauthenticationMethods.includes('apple') && Platform.OS === 'ios' ? (
            <AppleAuthentication.AppleAuthenticationButton
              accessibilityLabel="Continue with Apple and delete"
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              cornerRadius={appTheme.radii.md}
              onPress={() => {
                if (!isDeleting) void removeAccount({ method: 'apple' });
              }}
              style={{ height: 50, width: '100%', opacity: isDeleting ? appTheme.opacity.disabled : 1 }}
            />
          ) : null}

          {accountReauthenticationMethods.length === 0 ? (
            <StatusBlock
              tone="warning"
              title="Use the original sign-in device"
              body="Open Magic Booklet on the device used for this account, then try account deletion again."
            />
          ) : null}
        </Card>
      ) : null}

      <View style={{ gap: appTheme.spacing.gap }}>
        <AppText variant="bodySm" color="muted">
          Type DELETE to permanently remove {user?.email ?? 'this account'}.
        </AppText>
        <AppTextInput
          accessibilityLabel="Type DELETE to confirm"
          autoCapitalize="characters"
          editable={!isDeleting}
          label="Confirmation"
          onChangeText={setConfirmation}
          placeholder="DELETE"
          value={confirmation}
        />
      </View>

      {!needsReauthentication ? (
        <PrimaryButton
          accent="danger"
          accessibilityHint="Permanently deletes your account and personal data"
          disabled={!isConfirmed}
          label={isDeleting ? 'Deleting account…' : 'Permanently delete account'}
          loading={isDeleting}
          onPress={() => void removeAccount()}
        />
      ) : null}
      <SecondaryButton label="Keep my account" disabled={isDeleting} onPress={() => router.back()} />
    </Screen>
  );
}
