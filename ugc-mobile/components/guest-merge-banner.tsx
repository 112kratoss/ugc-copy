import { View } from 'react-native';

import { useAuth } from '@/lib/auth';
import { describeMergeOutcome } from '@/lib/guest-merge';
import { appTheme } from '@/lib/theme';

import { SecondaryButton, StatusBlock } from './ui';

/**
 * Tells a registered user what happened to the guest credits they arrived with.
 *
 * Non-blocking by design. A pending link is not an error — the ticket is stored
 * and retried on every launch and foreground — but the balance on screen is
 * smaller than the person expects until it lands, and saying nothing reads as
 * money that vanished at sign-up.
 *
 * Renders nothing in the common case, which is every user who was never a guest.
 */
export function GuestMergeBanner() {
  const { user, mergeState, mergeOutcome, acknowledgeMergeOutcome } = useAuth();

  if (!user) return null;

  if (mergeOutcome) {
    const outcome = describeMergeOutcome(mergeOutcome);
    return (
      <View style={{ gap: appTheme.spacing.compact }}>
        <StatusBlock
          tone={outcome.tone === 'success' ? 'success' : 'warning'}
          title={outcome.tone === 'success' ? 'Guest credits added' : 'Guest credits not added yet'}
          body={outcome.message}
        />
        <SecondaryButton label="Dismiss" onPress={acknowledgeMergeOutcome} />
      </View>
    );
  }

  // 'merging' is deliberately not surfaced: it lasts one request, and a banner
  // that flashes on every foreground is noise rather than information.
  if (mergeState === 'pending') {
    return (
      <StatusBlock
        tone="info"
        title="Adding your guest credits"
        body="The credits and creations from before you signed up are still on their way. We keep retrying — you do not need to do anything."
      />
    );
  }

  return null;
}
