import { BellRing } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { AppText, Card, PrimaryButton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { hexWithAlpha } from '@/lib/eased-fade';
import { usePushOffer } from '@/lib/push-prompt';
import { useDevicePushRegistration } from '@/lib/push-registration';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export type PushOfferMoment = 'creation' | 'post';

const OFFER_COPY: Record<PushOfferMoment, { title: string; body: string; enabled: string }> = {
  creation: {
    title: 'Get a notification when it’s ready',
    body: 'Usually about a minute. You can leave the app while it finishes.',
    enabled: 'Notifications are on. We’ll tell you when it’s ready.',
  },
  post: {
    title: 'Know when people react',
    body: 'Get a notification when someone saves, remixes or unlocks your post, or follows you.',
    enabled: 'Notifications are on. We’ll tell you when people react.',
  },
};

/**
 * Offers notifications at a moment they plainly help. One button, because it
 * leads straight to the system permission alert. Apple HIG, Privacy: a view
 * shown before that alert should "include only one button and make it clear
 * that it opens the system alert". The card is inline and never blocks, so
 * ignoring it is the "not now".
 */
export function PushOfferCard({
  moment,
  occasion,
}: {
  moment: PushOfferMoment;
  /** What this offer is about, e.g. `creation:<startedAt>` or `post:<id>`. */
  occasion: string;
}) {
  const theme = useAppTheme();
  const { user, isGuest, api } = useAuth();
  const registered = Boolean(user) && !isGuest;
  const push = useDevicePushRegistration({ api, userId: registered ? user?.id : null });
  const status = push.result?.status ?? null;
  const offered = usePushOffer({ occasion, registered, status });
  const [asked, setAsked] = useState(false);
  const copy = OFFER_COPY[moment];

  if (!offered) return null;

  if (asked && status === 'registered') {
    return (
      <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
        <BellRing size={appTheme.icon.xs} color={theme.colors.success} />
        <AppText variant="caption" color="muted" style={{ flex: 1 }}>{copy.enabled}</AppText>
      </View>
    );
  }

  // Declined at the system alert, or push is unavailable in this build: the
  // offer goes, and the Alerts screen keeps the way back in.
  if (status !== 'permission-required') return null;

  const failed = Boolean(push.enableError) && !push.isEnabling;
  return (
    <Card accent="primary" variant="soft" padding="sm" style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hexWithAlpha(theme.colors.primary, 0.12),
            borderWidth: 1,
            borderColor: hexWithAlpha(theme.colors.primary, 0.33),
          }}
        >
          <BellRing size={appTheme.icon.default} color={theme.colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <AppText variant="body" style={{ fontWeight: '700' }}>{copy.title}</AppText>
          <AppText variant="caption" color="muted">{copy.body}</AppText>
        </View>
      </View>
      {failed ? (
        <AppText accessibilityRole="alert" variant="caption" color="danger">
          Couldn’t turn on notifications. Try again.
        </AppText>
      ) : null}
      <PrimaryButton
        label="Notify me"
        loading={push.isEnabling}
        loadingLabel="Turning on…"
        onPress={() => {
          setAsked(true);
          push.enable();
        }}
      />
    </Card>
  );
}
