import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import { AppText, Card, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { env } from '@/lib/env';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { MarketplaceResource, PostResourceKind } from '@/lib/types';

function resourceLabel(kinds?: PostResourceKind[]) {
  if (!kinds || kinds.length === 0) return 'Creator unlock';
  return kinds.map((kind) => kind[0]?.toUpperCase() + kind.slice(1)).join(' · ');
}

function marketplaceAccent(accessMode?: MarketplaceResource['accessMode']): ToolAccent {
  return accessMode === 'free' ? 'workflow' : 'commerce';
}

function marketplacePriceLabel(detail: MarketplaceResource) {
  return detail.accessMode === 'free' ? 'Free unlock' : detail.priceQuote?.formatted ?? 'Paid unlock';
}

export default function MarketplaceAssetScreen() {
  const { assetId, postId } = useLocalSearchParams<{ assetId: string; postId?: string }>();
  const resourceId = Array.isArray(assetId) ? assetId[0] : assetId;
  const fallbackPostId = Array.isArray(postId) ? postId[0] : postId;
  const { user, api, credits, updateCredits } = useAuth();
  const queryClient = useQueryClient();
  const webUrl = `${env.siteUrl}/marketplace/${resourceId}`;

  const detailQuery = useQuery({
    queryKey: ['marketplace-resource', resourceId, fallbackPostId, user?.id],
    enabled: Boolean(resourceId),
    queryFn: async () => (await api.getMarketplaceResourceDetail(resourceId, { postId: fallbackPostId })).bundle,
  });

  const unlockMutation = useMutation({
    mutationFn: async () => {
      const detail = detailQuery.data;
      if (!detail?.postId) throw new Error('Missing post for unlock.');
      if (detail.accessMode === 'free') {
        return api.unlockFreeBundle(detail.postId);
      }
      return api.unlockBundleWithCredits(detail.postId);
    },
    onSuccess: async (result) => {
      if ('credits' in result && typeof result.credits === 'number') {
        updateCredits(result.credits);
      }
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', resourceId] });
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
    },
  });

  const detail = detailQuery.data;
  const resources = detail?.resources;

  return (
    <Screen>
      <SectionTitle
        eyebrow="Unlock detail"
        title={detail?.title ?? 'Creator unlock'}
        body={detail ? `${resourceLabel(detail.resourceKinds)} · ${detail.seller?.name ?? detail.creator?.name ?? 'Creator'}` : 'Loading unlock details.'}
      />

      {detailQuery.error ? (
        <StatusBlock
          tone="danger"
          title="Could not load unlock"
          body={detailQuery.error instanceof Error ? detailQuery.error.message : 'Try again.'}
        />
      ) : null}
      {unlockMutation.error ? (
        <StatusBlock
          tone="danger"
          title="Unlock failed"
          body={unlockMutation.error instanceof Error ? unlockMutation.error.message : 'Try again.'}
        />
      ) : null}

      {detail ? (
        <>
          <Card accent={marketplaceAccent(detail.accessMode)}>
            <MediaPreview url={detail.post?.mediaUrl ?? detail.mediaUrl ?? null} kind={detail.post?.mediaKind ?? null} />
            <View style={{ gap: appTheme.spacing.compact }}>
              <Pill label={marketplacePriceLabel(detail)} accent={marketplaceAccent(detail.accessMode)} />
              <AppText variant="body" color="text">
                {detail.summary ?? detail.description ?? detail.previewText ?? 'Reusable creator resource.'}
              </AppText>
              <AppText variant="bodySm" color="muted">
                {detail.previewText ?? 'Unlock includes creator-facing resources for this post.'}
              </AppText>
            </View>
          </Card>

          {detail.viewerCanAccess && resources ? (
            <Card accent="workflow">
              <View style={{ gap: 4 }}>
                <AppText variant="cardTitle">Unlocked resources</AppText>
                <AppText variant="caption" color="faint">{resourceLabel(detail.resourceKinds)}</AppText>
              </View>
              {resources.promptText ? (
                <AppText variant="bodySm" color="text">
                  {resources.promptText}
                </AppText>
              ) : null}
              {resources.notesMarkdown ? (
                <AppText variant="bodySm" color="muted">
                  {resources.notesMarkdown}
                </AppText>
              ) : null}
              {resources.attachments.length > 0 ? (
                <View style={{ gap: 8 }}>
                  {resources.attachments.map((attachment) => (
                    <AppText key={`${attachment.label}-${attachment.url ?? attachment.storagePath ?? ''}`} variant="bodySm" color="muted">
                      {attachment.kind ?? 'file'} · {attachment.label}
                    </AppText>
                  ))}
                </View>
              ) : null}
              {resources.workflowShareUrl || resources.workflowSnapshot ? (
                <View style={{ gap: 4 }}>
                  <AppText variant="label">Workflow is web-first</AppText>
                  <AppText variant="bodySm" color="muted">
                    Workflow snapshots can be viewed from mobile, but importing and editing stays on the web canvas in v1.
                  </AppText>
                </View>
              ) : null}
            </Card>
          ) : null}

          <Card>
            {!user ? (
              <View style={{ gap: 4 }}>
                <AppText variant="label">Sign in required</AppText>
                <AppText variant="bodySm" color="muted">Sign in before unlocking free or paid resources.</AppText>
              </View>
            ) : null}
            {detail.viewerCanAccess ? (
              <View style={{ gap: 4 }}>
                <AppText variant="label" color="success">Unlocked</AppText>
                <AppText variant="bodySm" color="muted">This resource is available on your account.</AppText>
              </View>
            ) : detail.accessMode === 'free' ? (
              <PrimaryButton
                label={unlockMutation.isPending ? 'Unlocking...' : 'Unlock free resources'}
                loading={unlockMutation.isPending}
                onPress={() => {
                  if (!user) {
                    router.push('/auth');
                    return;
                  }
                  unlockMutation.mutate();
                }}
                accent="workflow"
              />
            ) : (
              <View style={{ gap: 10 }}>
                <View style={{ gap: 4 }}>
                  <AppText variant="label">Unlock with credits</AppText>
                  <AppText variant="bodySm" color="muted">
                    Paid mobile unlocks now use your Magic Booklet credit balance instead of a separate store checkout.
                  </AppText>
                  <AppText variant="label" color="success">
                    Costs {detail.priceUsdCents ?? 0} credits • Balance {credits ?? 0}
                  </AppText>
                </View>
                <PrimaryButton
                  label={unlockMutation.isPending ? 'Unlocking...' : `Unlock for ${detail.priceUsdCents ?? 0} credits`}
                  loading={unlockMutation.isPending}
                  onPress={() => {
                    if (!user) {
                      router.push('/auth');
                      return;
                    }
                    unlockMutation.mutate();
                  }}
                  accent="commerce"
                />
              </View>
            )}
            <SecondaryButton label="Open listing on web" onPress={() => void Linking.openURL(webUrl)} />
          </Card>
        </>
      ) : !detailQuery.isLoading ? (
        <StatusBlock title="Unlock unavailable" body="This resource may be unlisted, private, or removed." />
      ) : null}
    </Screen>
  );
}
