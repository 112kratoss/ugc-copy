import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import {
  AppText,
  AppTextInput,
  ChoiceChip,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusBlock,
} from '@/components/ui';
import { announceQueued } from '@/lib/accessibility-announcement';
import { useAuth } from '@/lib/auth';
import {
  CREATOR_PAYOUT_ARRIVAL_DAYS,
  CREATOR_PAYOUT_COMING_SOON_LABELS,
  CREATOR_PAYOUT_DETAILS_CAUTION,
  CREATOR_PAYOUT_DETAILS_MAX_LENGTH,
  CREATOR_PAYOUT_DETAILS_MIN_LENGTH,
  CREATOR_PAYOUT_METHOD_OPTIONS,
  checkPayoutDetails,
  type CreatorPayoutMethod,
} from '@/lib/creator-payout-policy/creator-payout-policy';
import { payoutConfirmation, payoutRequestFailure } from '@/lib/creator-payout-view-model';
import { showConfirmDialog } from '@/lib/dialog';
import { CREATOR_PAYOUTS_QUERY_KEY, useCreatorPayoutState } from '@/lib/use-creator-payout-state';

/** The share a creator keeps of a paid unlock, as the web's form says it. */
const CREATOR_SHARE_PERCENT = 85;

/**
 * Withdraw: files a payout of the whole balance from the app (owner,
 * 2026-11-11), through the route the web's Recipe sales page uses. A screen of
 * its own rather than a sheet: an RN Modal may not hold a field
 * (`hig-modality.test.ts`), and a pushed screen needs no overlay host.
 */
export default function PayoutRequestScreen() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const payout = useCreatorPayoutState();
  const [method, setMethod] = useState<CreatorPayoutMethod>('upi');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A request in flight answers on this screen; leaving now would lose a
  // refusal along with it.
  usePreventRemove(submitting, () => {});

  const state = payout.data;
  const option = CREATOR_PAYOUT_METHOD_OPTIONS.find((entry) => entry.value === method) ?? CREATOR_PAYOUT_METHOD_OPTIONS[0];

  if (!state || !state.canRequest || state.pendingRequest) {
    return (
      <Screen>
        {payout.isLoading ? (
          <AppText variant="bodySm" color="muted">Loading your balance…</AppText>
        ) : (
          <StatusBlock
            title={state?.pendingRequest ? 'A payout is already on its way' : 'Nothing to withdraw yet'}
            body={state?.pendingRequest
              ? 'It has to be settled before you can request another.'
              : state ? `Payouts start at ${state.minimumUsd}.` : 'Your balance could not be loaded. Check your connection, then try again.'}
          />
        )}
        <SecondaryButton label="Back to Recipe Sales" onPress={() => router.back()} />
      </Screen>
    );
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: [CREATOR_PAYOUTS_QUERY_KEY] });

  const submit = async () => {
    const problem = checkPayoutDetails(method, details);
    if (problem) {
      setError(problem);
      return;
    }
    const question = payoutConfirmation(state.availableUsd, method, details);
    if (!(await showConfirmDialog(question))) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.requestCreatorPayout({ payoutMethod: method, payoutDetails: details.trim() });
      await refresh();
      announceQueued('Payout requested.');
      setSubmitting(false);
      router.back();
    } catch (requestError) {
      const failure = payoutRequestFailure(requestError);
      setError(failure.message);
      setSubmitting(false);
      // Another device filed one, or the balance moved: the card says which.
      if (failure.stale) void refresh();
    }
  };

  return (
    <Screen keyboardAware>
      {/* iOS 26's back swipe starts anywhere and beats usePreventRemove. */}
      <Stack.Screen options={{ gestureEnabled: !submitting }} />
      <SectionTitle
        title={`Withdraw ${state.availableUsd}`}
        body={`You keep ${CREATOR_SHARE_PERCENT}% of every paid unlock. Payouts are paid in INR to a UPI ID or an Indian bank account within ${CREATOR_PAYOUT_ARRIVAL_DAYS} days of your request.`}
      />

      <View style={{ gap: 8 }}>
        <AppText variant="label" color="textSecondary" accessibilityRole="header">Pay me by</AppText>
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CREATOR_PAYOUT_METHOD_OPTIONS.map((entry) => (
            <ChoiceChip
              key={entry.value}
              label={entry.label}
              active={method === entry.value}
              accent="commerce"
              disabled={submitting}
              onPress={() => {
                setMethod(entry.value);
                setError(null);
              }}
            />
          ))}
          {CREATOR_PAYOUT_COMING_SOON_LABELS.map((label) => (
            <ChoiceChip key={label} label={`${label} · Coming soon`} active={false} disabled onPress={() => {}} />
          ))}
        </View>
      </View>

      <AppTextInput
        label="Payout details"
        value={details}
        onChangeText={(text) => {
          setDetails(text);
          setError(null);
        }}
        placeholder={option.placeholder}
        maxLength={CREATOR_PAYOUT_DETAILS_MAX_LENGTH}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={option.keyboard === 'email' ? 'email-address' : 'default'}
        returnKeyType="done"
        editable={!submitting}
        error={error ?? undefined}
        hint={CREATOR_PAYOUT_DETAILS_CAUTION}
      />

      <PrimaryButton
        label="Request payout"
        loadingLabel="Requesting…"
        accent="commerce"
        loading={submitting}
        disabled={submitting || details.trim().length < CREATOR_PAYOUT_DETAILS_MIN_LENGTH}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
