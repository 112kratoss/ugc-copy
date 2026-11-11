import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
  CREATOR_PAYOUT_CREATOR_SHARE_PERCENT,
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

const PAYOUT_REQUEST_PATH = '/payout-request';
const RECIPE_SALES_PATH = '/seller-dashboard';

/** Back where Withdraw was opened from, or Recipe Sales when it was opened by a link. */
function leaveWithdraw() {
  if (router.canGoBack()) router.back();
  else router.replace(RECIPE_SALES_PATH as never);
}

/**
 * Withdraw: files a payout of the whole balance from the app (owner,
 * 2026-11-11), through the route the web's Recipe sales page uses. A screen of
 * its own rather than a sheet: an RN Modal may not hold a field
 * (`hig-modality.test.ts`), and a pushed screen needs no overlay host.
 */
export default function PayoutRequestScreen() {
  const { api, user } = useAuth();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const payout = useCreatorPayoutState();
  const [method, setMethod] = useState<CreatorPayoutMethod>('upi');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requested, setRequested] = useState(false);
  // Taken at the first tap and held until the dialog and the request settle:
  // the button only greys out once the request starts, after the dialog, so a
  // second tap would otherwise open a second dialog and send a second request.
  const busy = useRef(false);
  const leaving = useRef(false);

  // A request in flight answers on this screen; leaving now would lose a
  // refusal along with it. The guard can still be armed on the commit that
  // ends the request, so the way out after a request lets itself through.
  usePreventRemove(submitting, ({ data }) => {
    if (leaving.current) navigation.dispatch(data.action);
  });

  useEffect(() => {
    if (!requested) return;
    leaving.current = true;
    void queryClient.invalidateQueries({ queryKey: [CREATOR_PAYOUTS_QUERY_KEY] });
    announceQueued('Payout requested.');
    // The next tick, so the guard above has let go before the pop.
    const timer = setTimeout(leaveWithdraw, 0);
    return () => clearTimeout(timer);
  }, [requested, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: [CREATOR_PAYOUTS_QUERY_KEY] });

  if (requested) {
    return (
      <Screen>
        <StatusBlock
          tone="success"
          title="Payout requested"
          body={`It arrives within ${CREATOR_PAYOUT_ARRIVAL_DAYS} days of the request.`}
        />
      </Screen>
    );
  }

  if (!user) {
    return (
      <Screen>
        <SectionTitle title="Sign in to withdraw." body="Your recipe earnings are paid out to the account that made them." />
        <PrimaryButton
          label="Sign in"
          accent="primary"
          onPress={() => router.push({ pathname: '/auth', params: { returnTo: PAYOUT_REQUEST_PATH } } as never)}
        />
      </Screen>
    );
  }

  const state = payout.data;
  // A failed read wins over a balance an earlier read left, as on the card.
  if (payout.isError || !state || !state.canRequest || state.pendingRequest) {
    const unreadable = payout.isError || (!state && !payout.isLoading);
    return (
      <Screen>
        {!unreadable && !state ? (
          <AppText variant="bodySm" color="muted">Loading your balance…</AppText>
        ) : (
          <StatusBlock
            tone={unreadable ? 'danger' : 'neutral'}
            title={unreadable
              ? 'Your balance could not be loaded'
              : state?.pendingRequest ? 'A payout is already on its way' : 'Nothing to withdraw yet'}
            body={unreadable
              ? 'Check your connection, then try again.'
              : state?.pendingRequest
                ? 'It has to be settled before you can request another.'
                : `Payouts start at ${state?.minimumUsd}.`}
          />
        )}
        {unreadable ? (
          <SecondaryButton
            label={payout.isFetching ? 'Loading…' : 'Retry'}
            disabled={payout.isFetching}
            onPress={() => void payout.refetch()}
          />
        ) : null}
        <SecondaryButton label="Back to Recipe Sales" onPress={leaveWithdraw} />
      </Screen>
    );
  }

  const option = CREATOR_PAYOUT_METHOD_OPTIONS.find((entry) => entry.value === method) ?? CREATOR_PAYOUT_METHOD_OPTIONS[0];

  const submit = async () => {
    if (busy.current) return;
    const problem = checkPayoutDetails(method, details);
    if (problem) {
      setError(problem);
      return;
    }
    busy.current = true;
    try {
      if (!(await showConfirmDialog(payoutConfirmation(state.availableUsd, method, details)))) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.requestCreatorPayout({ payoutMethod: method, payoutDetails: details.trim() });
        setSubmitting(false);
        setRequested(true);
      } catch (requestError) {
        setError(payoutRequestFailure(requestError));
        setSubmitting(false);
        // Whatever went wrong, the balance on screen may no longer be true:
        // another device filed one, or a request timed out after it was taken.
        void refresh();
      }
    } finally {
      busy.current = false;
    }
  };

  return (
    <Screen keyboardAware>
      {/* iOS 26's back swipe starts anywhere and beats usePreventRemove. */}
      <Stack.Screen options={{ gestureEnabled: !submitting }} />
      <SectionTitle
        title={`Withdraw ${state.availableUsd}`}
        body={`You keep ${CREATOR_PAYOUT_CREATOR_SHARE_PERCENT}% of every paid unlock. Payouts are paid in INR to a UPI ID or an Indian bank account within ${CREATOR_PAYOUT_ARRIVAL_DAYS} days of your request.`}
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
