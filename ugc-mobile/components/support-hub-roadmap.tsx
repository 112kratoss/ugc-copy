import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ChevronRight, Hammer, Lightbulb, Rocket, Telescope } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

import { SkeletonBone } from '@/components/skeleton';
import { SupportHubReactions } from '@/components/support-hub-reactions';
import { AppText, PrimaryButton, SecondaryButton, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { textPostViewerHref } from '@/lib/immersive-preview-view-model';
import { openSignUpSheet } from '@/lib/join-navigation';
import {
  SUPPORT_HUB_WORDS,
  supportHubPath,
  type SupportHubReactionEmoji,
  type SupportRoadmapResponse,
  type SupportRoadmapStatus,
} from '@/lib/support-hub-policy/support-hub-policy';
import {
  createSupportHubReactor,
  supportRoadmapQueryKey,
  supportRoadmapRows,
  supportRoadmapSections,
  withSupportRoadmapReaction,
  type SupportRoadmapCard,
  type SupportRoadmapRow,
} from '@/lib/support-hub-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** The glyph beside a group's heading: a hammer for Building, a telescope for Exploring, a rocket for Shipped. */
function statusIcon(status: SupportRoadmapStatus) {
  if (status === 'building') return Hammer;
  if (status === 'exploring') return Telescope;
  return Rocket;
}

/**
 * Help & Support's Roadmap: what is being built, what is being explored, and
 * what shipped in the last thirty days, with no dates. People react to an
 * item, and the number of people is its vote; a shipped item opens the update
 * that announced it. "Suggest a feature" goes to the chat with the composer
 * started. Everyone reads it; a guest's reaction asks them to sign up.
 */
export function SupportRoadmapTab({ onSuggestFeature }: { onSuggestFeature: () => void }) {
  const { api, user } = useAuth();
  const theme = useAppTheme();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const roadmapQuery = useQuery({
    queryKey: supportRoadmapQueryKey(userId),
    queryFn: () => api.getSupportRoadmap(),
  });
  // A pull the reader made, not a refetch (support-hub-updates.tsx says why).
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);

  const items = roadmapQuery.data?.items;
  // Read against the time the roadmap was read, so the list does not change under the reader.
  const readAt = roadmapQuery.dataUpdatedAt;
  const rows = useMemo(() => supportRoadmapRows(supportRoadmapSections(items ?? [], readAt)), [items, readAt]);

  const reactor = useMemo(() => createSupportHubReactor({
    send: (id, emoji) => api.reactToSupportRoadmapItem(id, emoji),
    draw: (id, state) => {
      queryClient.setQueryData<SupportRoadmapResponse>(
        supportRoadmapQueryKey(userId),
        (data) => withSupportRoadmapReaction(data, id, state),
      );
    },
    failed: (id) => setFailedId(id),
  }), [api, queryClient, userId]);

  const react = (card: SupportRoadmapCard, emoji: SupportHubReactionEmoji) => {
    setFailedId((current) => (current === card.id ? null : current));
    reactor.press(card.id, card.reactions, emoji);
  };

  const signIn = () => openSignUpSheet(router, supportHubPath('roadmap'));

  const refresh = () => {
    setPullRefreshing(true);
    void roadmapQuery.refetch().finally(() => setPullRefreshing(false));
  };

  const emptyState = roadmapQuery.isError ? (
    <View style={{ gap: appTheme.spacing.gap }}>
      <StatusBlock tone="danger" title={SUPPORT_HUB_WORDS.roadmapLoadFailed} />
      <SecondaryButton
        label={SUPPORT_HUB_WORDS.tryAgain}
        loading={roadmapQuery.isRefetching}
        onPress={() => void roadmapQuery.refetch()}
      />
    </View>
  ) : roadmapQuery.isPending ? (
    <SupportRoadmapSkeleton />
  ) : (
    <StatusBlock title={SUPPORT_HUB_WORDS.roadmapEmptyTitle} body={SUPPORT_HUB_WORDS.roadmapEmptyBody} />
  );

  const renderRow = ({ item }: { item: SupportRoadmapRow }) => {
    if (item.kind === 'heading') {
      const Icon = statusIcon(item.status);
      return (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: appTheme.spacing.compact,
            paddingTop: item.first ? 0 : appTheme.spacing.section - appTheme.spacing.gap,
          }}
        >
          <Icon size={appTheme.icon.compact} color={theme.colors.primary} />
          <AppText heading variant="cardTitle" style={{ flexShrink: 1 }}>{item.heading}</AppText>
        </View>
      );
    }
    const { card } = item;
    const readUpdateId = card.readUpdateId;
    return (
      <View
        style={{
          gap: appTheme.spacing.gap,
          padding: appTheme.spacing.card,
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          backgroundColor: theme.colors.panel,
        }}
      >
        <View style={{ gap: appTheme.spacing.unit }}>
          <AppText variant="body" style={{ fontWeight: '700' }}>{card.title}</AppText>
          {card.summary ? <AppText variant="bodySm" color="textSecondary">{card.summary}</AppText> : null}
        </View>
        <AppText variant="caption" color="muted">{card.voteWords}</AppText>
        <SupportHubReactions
          subject={card.title}
          state={card.reactions}
          canReact={Boolean(user)}
          failed={failedId === card.id}
          onReact={(emoji) => react(card, emoji)}
          onSignIn={signIn}
        />
        {readUpdateId ? (
          // Wrapped rather than styled: a styled button grows to fill its parent (`flexGrow`),
          // and inside a list cell that drew it as a tall empty pill on the iPhone.
          <View style={{ alignSelf: 'flex-start' }}>
            <SecondaryButton
              label={SUPPORT_HUB_WORDS.readUpdate}
              trailingIcon={ChevronRight}
              onPress={() => router.push(textPostViewerHref({ postId: readUpdateId }) as never)}
            />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <FlatList
      data={rows}
      extraData={failedId}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      ItemSeparatorComponent={RoadmapSeparator}
      ListHeaderComponent={rows.length > 0 ? (
        <AppText variant="bodySm" color="muted" style={{ marginBottom: appTheme.spacing.panel }}>
          {SUPPORT_HUB_WORDS.roadmapIntro}
        </AppText>
      ) : null}
      ListEmptyComponent={emptyState}
      ListFooterComponent={roadmapQuery.isPending ? null : (
        <View
          style={{
            marginTop: appTheme.spacing.section,
            gap: appTheme.spacing.gap,
            padding: appTheme.spacing.card,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.surface,
          }}
        >
          <AppText variant="bodySm" color="textSecondary">{SUPPORT_HUB_WORDS.suggestFeatureLine}</AppText>
          <PrimaryButton label={SUPPORT_HUB_WORDS.suggestFeature} icon={Lightbulb} onPress={onSuggestFeature} />
        </View>
      )}
      onRefresh={refresh}
      refreshing={pullRefreshing}
      // No field here; should the chat's keyboard still be on its way down, a press on an item answers.
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        paddingHorizontal: appTheme.spacing.screen,
        paddingTop: appTheme.spacing.compact,
        paddingBottom: appTheme.spacing.section,
      }}
    />
  );
}

function RoadmapSeparator() {
  return <View style={{ height: appTheme.spacing.gap }} />;
}

/** A heading and two items' bones while the roadmap loads. */
function SupportRoadmapSkeleton() {
  const theme = useAppTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading the roadmap" style={{ gap: appTheme.spacing.gap }}>
      <SkeletonBone width="36%" height={22} strong />
      {[0, 1].map((index) => (
        <View
          key={index}
          style={{
            gap: appTheme.spacing.gap,
            padding: appTheme.spacing.card,
            borderRadius: appTheme.radii.lg,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.panel,
          }}
        >
          {/* Uneven widths so the stack reads as content rather than a pattern. */}
          <SkeletonBone width={index === 0 ? '64%' : '52%'} height={18} strong />
          <SkeletonBone width="88%" height={13} radius={appTheme.radii.pill} />
          <SkeletonBone width="40%" height={32} radius={appTheme.radii.pill} />
        </View>
      ))}
    </View>
  );
}
