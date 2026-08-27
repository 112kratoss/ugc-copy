import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import { PostResourceBundleContent } from '@/components/post-resource-bundle-content';
import { DetailSkeleton } from '@/components/skeleton';
import { AppText, Card, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { showActionSheet } from '@/lib/action-sheet';
import { useAuth } from '@/lib/auth';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { formatCreditAmount } from '@/lib/pricing';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { MarketplaceResource, PostResourceKind } from '@/lib/types';
import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';
import { formatUnlockPrice } from '@/lib/unlock-library-view-model';

function resourceLabel(kinds?: PostResourceKind[]) {
  if (!kinds || kinds.length === 0) return 'Creator unlock';
  return kinds.map((kind) => kind[0]?.toUpperCase() + kind.slice(1)).join(' · ');
}

function marketplaceAccent(accessMode?: MarketplaceResource['accessMode']): ToolAccent {
  return accessMode === 'free' ? 'workflow' : 'commerce';
}

function marketplacePriceLabel(detail: MarketplaceResource) {
  return detail.accessMode === 'free' ? 'Free unlock' : formatUnlockPrice(detail.priceUsdCents ?? 0);
}

export default function MarketplaceAssetScreen() {
  const { assetId, postId } = useLocalSearchParams<{ assetId: string; postId?: string }>();
  const resourceId = Array.isArray(assetId) ? assetId[0] : assetId;
  const fallbackPostId = Array.isArray(postId) ? postId[0] : postId;
  const { user, api, credits, updateCredits } = useAuth();
  const queryClient = useQueryClient();
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

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
      const postId = detailQuery.data?.postId;
      if (postId && resourceId) {
        await refreshUnlockedBundleCaches(queryClient, { postId, resourceId });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resource', resourceId] });
      await queryClient.invalidateQueries({ queryKey: ['marketplace-resources'] });
    },
  });

  const detail = detailQuery.data;
  const resources = detail?.resources;
  const unlockPrice = detail?.priceUsdCents ?? 0;
  const creditShortfall = Math.max(0, unlockPrice - (credits ?? 0));

  // A paid unlock spends the balance immediately and cannot be undone, so it
  // gets the confirmation step the system purchase sheet gives real-money
  // buys. Free unlocks stay one tap.
  const confirmPaidUnlock = () => {
    showActionSheet({
      title: 'Unlock this resource?',
      message: `${formatUnlockPrice(unlockPrice)} comes off your credit balance right away.`,
      actions: [{
        label: `Unlock for ${unlockPrice} credits`,
        onPress: () => unlockMutation.mutate(),
      }],
    });
  };
  const resourceMediaItems = useMemo(() => {
    if (!detail?.post) return [];
    if (detail.post.mediaItems?.length) return detail.post.mediaItems;
    if (!detail.post.mediaUrl || !detail.post.mediaKind) return [];
    return [{
      id: `${detail.post.id}:cover`,
      mediaKey: `${detail.post.id}:cover`,
      url: detail.post.mediaUrl,
      mediaKind: detail.post.mediaKind,
      contentType: null,
      originalName: null,
      width: null,
      height: null,
      durationSeconds: null,
      sortOrder: 0,
    }];
  }, [detail?.post]);

  const resolveResourceFileUrl = async (storagePath: string) => {
    if (!detail?.postId) throw new Error('Missing post for this resource.');
    const response = await api.getPostResourceFileUrl(detail.postId, storagePath);
    return response.signedUrl;
  };

  const openResourceFile = async ({ storagePath }: { storagePath: string; title: string; contentType: string | null }) => {
    try {
      setResourceError(null);
      setFileLoadingPath(storagePath);
      await Linking.openURL(await resolveResourceFileUrl(storagePath));
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : 'Could not open this resource.');
    } finally {
      setFileLoadingPath(null);
    }
  };

  const openResourceUrl = async (url: string) => {
    try {
      setResourceError(null);
      await Linking.openURL(url);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : 'Could not open this link.');
    }
  };

  return (
    <Screen>
      <SectionTitle
        eyebrow="Unlock detail"
        title={detail?.title ?? 'Creator unlock'}
        // Without the error branch this still read "Loading unlock details."
        // directly above a failure notice, so the page contradicted itself.
        body={detail
          ? `${resourceLabel(detail.resourceKinds)} · ${detail.seller?.name ?? detail.creator?.name ?? 'Creator'}`
          : detailQuery.isError
            ? 'This unlock could not be opened.'
            : 'Loading unlock details.'}
      />

      {detailQuery.error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock
            tone="danger"
            title="Could not load unlock"
            body="Check your connection, then try again."
          />
          <SecondaryButton label="Retry unlock" onPress={() => void detailQuery.refetch()} />
        </View>
      ) : null}
      {detailQuery.isLoading ? <DetailSkeleton label="Loading unlock details" /> : null}
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

          <Card accent={detail.viewerCanAccess ? 'workflow' : marketplaceAccent(detail.accessMode)}>
            <View style={{ gap: 4 }}>
              <AppText variant="cardTitle">{detail.viewerCanAccess ? 'Unlocked resources' : "What's included"}</AppText>
              <AppText variant="caption" color="faint">{resourceLabel(detail.resourceKinds)}</AppText>
            </View>
            <PostResourceBundleContent
              fileLoadingPath={fileLoadingPath}
              lockedPreview={detail.lockedPreview}
              mediaItems={resourceMediaItems}
              onCopy={(text) => copyToClipboard(text)}
              onError={setResourceError}
              onOpenFile={openResourceFile}
              onOpenUrl={openResourceUrl}
              resolveFileUrl={resolveResourceFileUrl}
              resources={detail.viewerCanAccess ? resources ?? null : null}
            />
            {resourceError ? <StatusBlock tone="danger" title="Resource unavailable" body={resourceError} /> : null}
          </Card>

          <Card>
            {!user ? (
              <View style={{ gap: appTheme.spacing.gap }}>
                <AppText variant="label">Sign in required</AppText>
                <AppText variant="bodySm" color="muted">Sign in before unlocking free or paid resources.</AppText>
                <PrimaryButton label="Sign in to unlock" onPress={() => router.push('/auth')} accent="primary" />
              </View>
            ) : detail.viewerCanAccess ? (
              <View style={{ gap: 4 }}>
                <AppText variant="label" color="success">Unlocked</AppText>
                <AppText variant="bodySm" color="muted">This resource is available on your account.</AppText>
              </View>
            ) : detail.accessMode === 'free' ? (
              <PrimaryButton
                label={unlockMutation.isPending ? 'Getting resources…' : 'Get resources — Free'}
                loading={unlockMutation.isPending}
                onPress={() => {
                  if (!user) {
                    router.push('/auth');
                    return;
                  }
                  unlockMutation.mutate();
                }}
                accent="primary"
              />
            ) : (
              <View style={{ gap: 10 }}>
                <View style={{ gap: 4 }}>
                  <AppText variant="label">Unlock with credits</AppText>
                  <AppText variant="bodySm" color="muted">
                    Paid mobile unlocks use your Magicbooklet credit balance instead of a separate store checkout.
                  </AppText>
                  <AppText variant="label" color={creditShortfall > 0 ? 'warning' : 'success'}>
                    Costs {formatUnlockPrice(unlockPrice)} · Balance {formatCreditAmount(credits)}
                  </AppText>
                  {creditShortfall > 0 ? (
                    <AppText variant="bodySm" color="muted">
                      You need {formatCreditAmount(creditShortfall)} more credits for this unlock.
                    </AppText>
                  ) : null}
                </View>
                <PrimaryButton
                  label={unlockMutation.isPending ? 'Unlocking…' : `Unlock for ${unlockPrice} credits`}
                  loading={unlockMutation.isPending}
                  disabled={creditShortfall > 0 || unlockMutation.isPending}
                  onPress={confirmPaidUnlock}
                  accent="primary"
                />
                {creditShortfall > 0 ? (
                  <SecondaryButton label="Get credits" onPress={() => router.push('/pricing' as never)} />
                ) : null}
              </View>
            )}
          </Card>
        </>
      ) : !detailQuery.isLoading ? (
        <StatusBlock title="Unlock unavailable" body="This resource may be unlisted, private, or removed." />
      ) : null}
    </Screen>
  );
}
