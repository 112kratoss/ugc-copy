import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { AppText, AppTextInput, Card, PrimaryButton, SecondaryButton, SectionTitle, StatusBlock, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function DeleteAccountScreen() {
  const { deleteAccount, user } = useAuth();
  const [confirmation, setConfirmation] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isConfirmed = confirmation.trim().toUpperCase() === 'DELETE';

  const removeAccount = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      Alert.alert('Account deleted', 'Your Magic Booklet account and personal data were permanently deleted.');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Account deletion could not be completed.');
      setIsDeleting(false);
    }
  };

  return (
    <Screen>
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

      <PrimaryButton
        accent="danger"
        accessibilityHint="Permanently deletes your account and personal data"
        disabled={!isConfirmed}
        label={isDeleting ? 'Deleting account…' : 'Permanently delete account'}
        loading={isDeleting}
        onPress={() => void removeAccount()}
      />
      <SecondaryButton label="Keep my account" disabled={isDeleting} onPress={() => router.back()} />
    </Screen>
  );
}
