import { router } from 'expo-router';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText, Card, PrimaryButton, StatusBlock } from '@/components/ui';
import { getCreatorPayoutCard, type CreatorPayoutHistoryRow } from '@/lib/creator-payout-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { useCreatorPayoutState } from '@/lib/use-creator-payout-state';

/**
 * Recipe Sales' payout card: the balance, the way to the $100 floor, Withdraw
 * once a request can go in, a payout in progress, the last one turned down,
 * and the history (owner, 2026-11-11: withdraw in the app). Every rule is the
 * view model's, which the web's Earnings tile follows too.
 */
export function CreatorPayoutCard({
  payout,
}: {
  payout: Pick<ReturnType<typeof useCreatorPayoutState>, 'data' | 'isError'>;
}) {
  const theme = useAppTheme();
  const card = getCreatorPayoutCard(payout);

  if (card.kind === 'loading' || card.kind === 'unavailable') {
    return (
      <Card>
        {/* A string in every state: Android never clears a label that goes back
            to undefined, and TalkBack read "loading" under the loaded balance. */}
        <AppText
          variant="bodySm"
          color="textSecondary"
          accessibilityLabel={card.kind === 'loading' ? 'Payout balance loading' : card.caption}
        >
          {card.kind === 'loading' ? `Payout balance ${card.balance}` : card.caption}
        </AppText>
      </Card>
    );
  }

  return (
    <Card accent="commerce">
      <View accessible accessibilityLabel={`Payout balance ${card.balance}. ${card.caption}`} style={{ gap: 4 }}>
        <AppText variant="caption" color="faint">Payout balance</AppText>
        <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>{card.balance}</AppText>
        <AppText variant="bodySm" color="muted">{card.caption}</AppText>
      </View>

      {card.rejection ? <StatusBlock tone="danger" title={card.rejection.title} body={card.rejection.body} /> : null}

      {card.pending ? (
        <StatusBlock tone="success" title={card.pending.title} body={card.pending.body} />
      ) : card.kind === 'ready' ? (
        <PrimaryButton
          label={card.withdrawLabel}
          accent="commerce"
          onPress={() => router.push('/payout-request' as never)}
        />
      ) : (
        <View style={{ gap: 8 }}>
          {card.progress !== null ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Balance toward the payout minimum"
              accessibilityValue={{ min: 0, max: 100, now: Math.round(card.progress * 100) }}
              style={{ height: 6, borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.surface, overflow: 'hidden' }}
            >
              <View style={{ width: `${card.progress * 100}%`, height: '100%', borderRadius: appTheme.radii.pill, backgroundColor: theme.colors.commerce }} />
            </View>
          ) : null}
          <AppText variant="caption" color="muted">{card.railsLine}</AppText>
        </View>
      )}

      {card.history.length > 0 ? <PayoutHistory rows={card.history} /> : null}
    </Card>
  );
}

function PayoutHistory({ rows }: { rows: CreatorPayoutHistoryRow[] }) {
  const theme = useAppTheme();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Payout history, ${rows.length}`}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          opacity: pressed ? appTheme.opacity.pressed : 1,
        })}
      >
        <AppText variant="bodySm" color="muted">{`Payout history (${rows.length})`}</AppText>
        <Chevron size={18} color={theme.colors.muted} />
      </Pressable>
      {open ? (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}>
          {rows.map((row) => (
            <View key={row.id} accessible accessibilityLabel={[row.title, row.date, row.note].filter(Boolean).join(', ')} style={{ gap: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <AppText variant="bodySm" color="textSecondary">{row.title}</AppText>
                <AppText variant="caption" color="faint">{row.date}</AppText>
              </View>
              {row.note ? <AppText variant="caption" color={row.noteTone}>{row.note}</AppText> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
