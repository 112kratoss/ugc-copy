import { View } from 'react-native';

import { useAuth } from '@/lib/auth';
import { describeGuestMergeOutcome } from '@/lib/guest-merge';
import { appTheme } from '@/lib/theme';

import { SecondaryButton, StatusBlock } from './ui';

/**
 * Tells a registered user what happened to the guest credits they arrived with
 * (audit 02-8): how many were added, or why they were not.
 *
 * The outcome is kept on the device until the person dismisses it here, so a
 * restart before they look loses nothing, and a balance that jumped at sign-up
 * has its reason on screen. A link still on its way is not shown: the ticket is
 * retried on every launch and foreground, and a banner that came and went with
 * each retry would be noise.
 *
 * Renders nothing without an outcome, which is everyone who was never a guest
 * with credits, so it can be mounted for guests and accounts alike.
 */
export function GuestMergeBanner() {
  const { guestMergeOutcome, dismissGuestMergeOutcome } = useAuth();
  const copy = guestMergeOutcome ? describeGuestMergeOutcome(guestMergeOutcome) : null;
  if (!copy) return null;

  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <StatusBlock tone={copy.tone} title={copy.title} body={copy.message} />
      <SecondaryButton label="Dismiss" onPress={dismissGuestMergeOutcome} />
    </View>
  );
}
