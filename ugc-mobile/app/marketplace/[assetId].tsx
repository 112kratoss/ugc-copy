import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import { PostResourceBundleContent } from '@/components/post-resource-bundle-content';
import { DetailSkeleton } from '@/components/skeleton';
import { AppText, Card, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { resourceKindLabel } from '@/lib/post-resource-bundle-view-model';
import { CREDIT_BALANCE_LOADING_LABEL, FREE_RECIPE_LABEL, formatCreditAmount } from '@/lib/pricing';
import { appTheme, type ToolAccent } from '@/lib/theme';
import type { MarketplaceResource, PostResourceKind } from '@/lib/types';
import {
  getUnlockSpendableCredits,
  holdsPromotionalCredits,
  PROMOTIONAL_CREDITS_NOTE,
  useBundleUnlock,
} from '@/lib/use-bundle-unlock';
import { formatUnlockPrice } from '@/lib/unlock-library-view-model';

function resourceLabel(kinds?: PostResourceKind[]) {
  const labels = (kinds ?? []).map(resourceKindLabel).filter(Boolean);
  return labels.length ? labels.join(' · ') : 'Recipe';
}

function marketplaceAccent(accessMode?: MarketplaceResource['accessMode']): ToolAccent {
  return accessMode === 'free' ? 'workflow' : 'commerce';
}

function marketplacePriceLabel(detail: MarketplaceResource) {
  return detail.accessMode === 'free' ? FREE_RECIPE_LABEL : formatUnlockPrice(detail.priceUsdCents ?? 0);
}

export default function MarketplaceAssetScreen() {
  const { assetId, postId } = useLocalSearchParams<{ assetId: string; postId?: string }>();
  const resourceId = Array.isArray(assetId) ? assetId[0] : assetId;
  const fallbackPostId = Array.isArray(postId) ? postId[0] : postId;
  const { user, api, credits, marketplaceSpendableCredits } = useAuth();
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['marketplace-resource', resourceId, fallbackPostId, user?.id],
    enabled: Boolean(resourceId),
    queryFn: async () => (await api.getMarketplaceResourceDetail(resourceId, { postId: fallbackPostId })).bundle,
  });

  const detail = detailQuery.data;
  const resources = detail?.resources;
  const unlockPrice = detail?.priceUsdCents ?? 0;
  // The balance this screen shows is what the unlock can spend: the total the
  // rest of the app shows also holds welcome and referral credits, which a
  // recipe cannot be bought with.
  const spendableCredits = getUnlockSpendableCredits(credits, marketplaceSpendableCredits);
  // An unknown balance is not an empty one. Until the profile request answers
  // there is no shortfall to report, and the unlock itself is checked against
  // the real balance on the server.
  const balanceKnown = spendableCredits !== null;
  // Where sign-in comes back to; a bare /auth landed the buyer on Home.
  const unlockPath = `/marketplace/${encodeURIComponent(String(assetId))}${postId ? `?postId=${encodeURIComponent(String(postId))}` : ''}`;
  // A paid unlock asks first, in the words every unlock now uses; free stays
  // one tap (`useBundleUnlock`).
  const bundleUnlock = useBundleUnlock({
    authReturnTo: unlockPath,
    target: detail?.postId && resourceId
      ? {
        postId: detail.postId,
        resourceId,
        accessMode: detail.accessMode === 'free' ? 'free' : 'paid',
        priceUsdCents: unlockPrice,
      }
      : null,
  });
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

  // Memoized: every reference preview signs through this, and the previews
  // one render mounts are signed together in one request.
  const bundlePostId = detail?.postId;
  const resolveResourceFileUrl = useCallback(async (storagePath: string) => {
    if (!bundlePostId) throw new Error('Missing post for this resource.');
    return api.resolvePostResourceFileUrl(bundlePostId, storagePath, { disposition: 'inline' });
  }, [api, bundlePostId]);

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

  const isUnlockGone = detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  return (
    <Screen>
      <SectionTitle
        eyebrow="Recipe details"
        title={detail?.title ?? 'Recipe'}
        // Without the error branch this still read "Loading recipe details."
        // directly above a failure notice, so the page contradicted itself.
        body={detail
          ? `${resourceLabel(detail.resourceKinds)} · ${detail.seller?.name ?? detail.creator?.name ?? 'Creator'}`
          : detailQuery.isError
            ? 'This recipe could not be opened.'
            : 'Loading recipe details.'}
      />

      {detailQuery.error ? (
        // A 404 is the unlock being gone (a removed listing opened from an
        // alert), not a connection problem; the two used to show together.
        isUnlockGone ? (
          <StatusBlock title="Recipe unavailable" body="This resource may be unlisted, private, or removed." />
        ) : (
          <View style={{ gap: appTheme.spacing.gap }}>
            <StatusBlock
              tone="danger"
              title="Could not load recipe"
              body="Check your connection, then try again."
            />
            <SecondaryButton label="Retry recipe" onPress={() => void detailQuery.refetch()} />
          </View>
        )
      ) : null}
      {detailQuery.isLoading ? <DetailSkeleton label="Loading recipe details" /> : null}
      {bundleUnlock.error ? (
        <StatusBlock tone="danger" title="Unlock failed" body={bundleUnlock.error} />
      ) : null}

      {detail ? (
        <>
          <Card accent={marketplaceAccent(detail.accessMode)}>
            <MediaPreview url={detail.post?.mediaUrl ?? detail.mediaUrl ?? null} kind={detail.post?.mediaKind ?? null} />
            <View style={{ gap: appTheme.spacing.compact }}>
              <Pill label={marketplacePriceLabel(detail)} accent={marketplaceAccent(detail.accessMode)} />
              <AppText variant="body" color="text">
                {detail.summary || detail.description || detail.previewText || 'Reusable creator resource.'}
              </AppText>
              <AppText variant="bodySm" color="muted">
                {detail.previewText || 'This recipe includes creator-facing resources for this post.'}
              </AppText>
            </View>
          </Card>

          <Card accent={detail.viewerCanAccess ? 'workflow' : marketplaceAccent(detail.accessMode)}>
            <View style={{ gap: 4 }}>
              <AppText variant="cardTitle">{detail.viewerCanAccess ? 'Your recipe' : 'In this recipe'}</AppText>
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
                <PrimaryButton label="Sign in to unlock" onPress={bundleUnlock.request} accent="primary" />
              </View>
            ) : detail.viewerCanAccess ? (
              <View style={{ gap: 4 }}>
                {/* The creator reads their own recipe by owning it, not by
                    having unlocked it, as Details and the web panel say. */}
                <AppText variant="label" color="success">{detail.viewerIsOwner ? 'Owner access' : 'Unlocked'}</AppText>
                <AppText variant="bodySm" color="muted">This resource is available on your account.</AppText>
              </View>
            ) : detail.accessMode === 'free' ? (
              <PrimaryButton
                label={bundleUnlock.isPending ? 'Getting resources…' : 'Get resources — Free'}
                loading={bundleUnlock.isPending}
                onPress={bundleUnlock.request}
                accent="primary"
              />
            ) : (
              <View style={{ gap: 10 }}>
                <View style={{ gap: 4 }}>
                  <AppText variant="label">Unlock with credits</AppText>
                  <AppText variant="bodySm" color="muted">
                    Paid mobile unlocks use your Magicbooklet credit balance instead of a separate store checkout.
                  </AppText>
                  <AppText variant="label" color={!balanceKnown ? 'muted' : bundleUnlock.shortfall > 0 ? 'warning' : 'success'}>
                    Costs {formatUnlockPrice(unlockPrice)} · {balanceKnown ? `Balance ${formatCreditAmount(spendableCredits)}` : CREDIT_BALANCE_LOADING_LABEL}
                  </AppText>
                  {/* The note rides with a shortfall (`formatBundleUnlockShortfall`);
                      with none it stands alone, since this balance is still
                      below the total the app shows elsewhere. */}
                  {bundleUnlock.shortfallMessage ? (
                    <AppText variant="bodySm" color="muted">{bundleUnlock.shortfallMessage}</AppText>
                  ) : holdsPromotionalCredits(credits, marketplaceSpendableCredits) ? (
                    <AppText variant="bodySm" color="muted">{PROMOTIONAL_CREDITS_NOTE}</AppText>
                  ) : null}
                </View>
                <PrimaryButton
                  label={bundleUnlock.isPending ? 'Unlocking…' : `Unlock for ${formatUnlockPrice(unlockPrice)}`}
                  loading={bundleUnlock.isPending}
                  disabled={bundleUnlock.shortfall > 0 || bundleUnlock.isPending}
                  onPress={bundleUnlock.request}
                  accent="primary"
                />
                {bundleUnlock.offersCredits ? (
                  <SecondaryButton label="Get credits" onPress={bundleUnlock.goToCredits} />
                ) : null}
              </View>
            )}
          </Card>
        </>
      ) : !detailQuery.isLoading && !detailQuery.error ? (
        <StatusBlock title="Recipe unavailable" body="This resource may be unlisted, private, or removed." />
      ) : null}
    </Screen>
  );
}
