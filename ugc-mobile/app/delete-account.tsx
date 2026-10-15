import { useQuery } from '@tanstack/react-query';
import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { AppText, AppTextInput, Card, PrimaryButton, SecondaryButton, SectionTitle, StatusBlock, Screen, WebLinkButton } from '@/components/ui';
import type { CreatorPayoutStateResponse } from '@/lib/api-client';
import { isAppleAuthCanceled } from '@/lib/apple-auth';
import {
  ACCOUNT_DELETION_SCHEDULED_NOTICE,
  AccountReauthenticationFailedError,
  isAccountReauthenticationRequired,
  useAuth,
  type AccountDeletionReauthentication,
  type AccountReauthenticationMethod,
} from '@/lib/auth';
import { describePasswordSignInError, describeProviderSignInError, type SignInProvider } from '@/lib/auth-error-copy';
import { showMessageDialog } from '@/lib/dialog';
import { env } from '@/lib/env';
import { isGoogleAuthCanceled } from '@/lib/google-auth';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

type DeletionFailure = { tone: 'danger' | 'warning'; title: string; body: string };

/**
 * The answer to the deletion was lost and Supabase could not say whether it
 * started (audit 04-3). The web's own sentence, so both say the same thing.
 * This phone is still signed in, and a retry settles it either way.
 */
const DELETION_UNCONFIRMED: DeletionFailure = {
  tone: 'warning',
  title: 'Deletion not confirmed',
  body: 'We could not confirm the deletion. Check the connection and try again.',
};

function notDeleted(reason: string): DeletionFailure {
  return {
    tone: 'danger',
    title: 'Account was not deleted',
    body: `${reason} Your account is still active. You can retry below.`,
  };
}

/**
 * Why the account was not deleted, in words written for people: the server's
 * own sentence when it sent one. A refused session's is "Unauthorized", and a
 * failure answered by the platform carries only its status.
 */
function notDeletedReason(error: unknown) {
  const { status, details } = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    details?: unknown;
  };
  const answeredWithoutJson = typeof status === 'number' && status >= 500
    && (typeof details !== 'object' || details === null);
  if (status === 401 || answeredWithoutJson) return 'The deletion did not go through.';
  return error instanceof Error ? error.message : 'Account deletion could not be completed.';
}

/**
 * A failed sign-in, in the sign-in screen's words rather than Supabase's or a
 * developer's (audit 01-7), naming only the ways in this screen draws. Nothing
 * for a sign-in the person canceled.
 */
function reauthenticationFailure(
  error: AccountReauthenticationFailedError,
  methods: AccountReauthenticationMethod[],
): DeletionFailure | null {
  const { method, failure } = error;
  if ((method === 'apple' && isAppleAuthCanceled(failure)) || (method === 'google' && isGoogleAuthCanceled(failure))) {
    return null;
  }
  const providerButtons = methods.flatMap((drawn): SignInProvider[] => {
    if (drawn === 'google') return ['Google'];
    return drawn === 'apple' && Platform.OS === 'ios' ? ['Apple'] : [];
  });
  const notice = method === 'password'
    ? describePasswordSignInError(failure, { providerButtons, asksForEmail: false })
    : describeProviderSignInError(failure, method === 'apple' ? 'Apple' : 'Google', {
      passwordAvailable: methods.includes('password'),
    });
  return { tone: 'danger', title: notice.title, body: `${notice.body} Your account is still active.` };
}

export default function DeleteAccountScreen() {
  const theme = useAppTheme();
  const { accountReauthenticationMethods, api, deleteAccount, user } = useAuth();
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [failure, setFailure] = useState<DeletionFailure | null>(null);
  const isConfirmed = confirmation.trim().toUpperCase() === 'DELETE';
  // A seller's balance not yet paid out goes with the account, so the screen
  // says how much before anything is typed. It never holds the deletion up.
  const payoutQuery = useQuery({
    queryKey: ['creator-payouts', user?.id ?? null],
    enabled: Boolean(user),
    queryFn: api.getCreatorPayoutState,
  });

  const removeAccount = async (reauthentication?: AccountDeletionReauthentication) => {
    setIsDeleting(true);
    setFailure(null);
    try {
      const outcome = await deleteAccount(reauthentication);
      if (outcome === 'unconfirmed') {
        // Still signed in here, so the screen stays and the retry is offered.
        setFailure(DELETION_UNCONFIRMED);
        setIsDeleting(false);
        return;
      }
      // Managing accounts: notify when deletion is finished. The phone is
      // already on Home as a guest, so the notice is not left over a screen
      // whose account no longer exists.
      showMessageDialog(outcome === 'deleted'
        ? {
          title: 'Account deleted',
          message: 'Your Magicbooklet account and personal data were permanently deleted.',
        }
        : ACCOUNT_DELETION_SCHEDULED_NOTICE);
    } catch (nextError) {
      if (nextError instanceof AccountReauthenticationFailedError) {
        setFailure(reauthenticationFailure(nextError, accountReauthenticationMethods));
        setIsDeleting(false);
        return;
      }
      if (isAccountReauthenticationRequired(nextError)) {
        setNeedsReauthentication(true);
        if (reauthentication) {
          setFailure(notDeleted(nextError instanceof Error
            ? nextError.message
            : 'Apple verification did not complete. Continue with Apple again and retry.'));
        }
        setIsDeleting(false);
        return;
      }
      setFailure(notDeleted(notDeletedReason(nextError)));
      setIsDeleting(false);
    }
  };

  return (
    <Screen keyboardAware>
      <SectionTitle
        eyebrow="Account"
        title="Delete your account"
        body="This permanently removes your Magicbooklet account, effective immediately. This action cannot be undone."
      />

      <UnpaidEarningsWarning payout={payoutQuery.data} unknown={payoutQuery.isError} />

      <Card style={{ borderColor: theme.semantic.danger.border }}>
        <AppText variant="cardTitle" color="danger">What will be deleted</AppText>
        <View style={{ gap: appTheme.spacing.compact }}>
          <AppText variant="bodySm" color="muted">• Your profile and sign-in credentials</AppText>
          <AppText variant="bodySm" color="muted">• Your public posts and comments</AppText>
          <AppText variant="bodySm" color="muted">• Private creations, uploads, templates, and saved items</AppText>
          <AppText variant="bodySm" color="muted">• Remaining credits and purchase-linked account access</AppText>
        </View>
        <AppText variant="cardTitle">What is kept</AppText>
        <AppText variant="bodySm" color="muted">
          People who bought your recipes keep them.
        </AppText>
        <AppText variant="bodySm" color="muted">
          A one-way digest of your sign-in identifiers, so the one-time welcome credits cannot be claimed again by a new account, plus the legal and tax records of your purchases and routine backups for a limited time.
        </AppText>
        <WebLinkButton href={`${env.siteUrl}/delete-account`} label="Read the full deletion policy" />
      </Card>

      {failure ? <StatusBlock tone={failure.tone} title={failure.title} body={failure.body} /> : null}

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
              body="Open Magicbooklet on the device used for this account, then try account deletion again."
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

/**
 * A seller's balance not yet paid out is forfeited with the account (a payout
 * already requested is still paid). Said with the amount when there is one, in
 * general terms when the balance could not be read, and not at all when there
 * is nothing to lose. Payouts are requested on the website.
 */
function UnpaidEarningsWarning({
  payout,
  unknown,
}: {
  payout: CreatorPayoutStateResponse | undefined;
  unknown: boolean;
}) {
  const payoutLink = (
    <WebLinkButton href={`${env.siteUrl}/marketplace/sell`} label="Request a payout first" />
  );
  if (unknown) {
    return (
      <>
        <StatusBlock
          tone="warning"
          title="Unpaid sales earnings will be forfeited"
          body="Your sales balance could not be checked. If you sell recipes, request your payout before you delete your account."
        />
        {payoutLink}
      </>
    );
  }
  if (!payout || payout.availableTokenSubunits <= 0) return null;
  const belowMinimum = payout.availableTokenSubunits < payout.minimumTokenSubunits;
  return (
    <>
      <StatusBlock
        tone="warning"
        title={`Unpaid sales earnings of ${payout.availableUsd} will be forfeited`}
        body={payout.canRequest
          ? 'Request a payout on the website before you delete your account.'
          : belowMinimum ? `Payouts start at ${payout.minimumUsd}, so this balance cannot be paid out.` : undefined}
      />
      {payout.canRequest ? payoutLink : null}
    </>
  );
}
