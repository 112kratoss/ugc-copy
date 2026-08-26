import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import { PostResourceBundleContent } from '@/components/post-resource-bundle-content';
import { DetailSkeleton } from '@/components/skeleton';
import { AppText, Card, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { appTheme } from '@/lib/theme';

export default function ViewerUnlockScreen() {
  const { unlockId: routeUnlockId } = useLocalSearchParams<{ unlockId: string }>();
  const unlockId = Array.isArray(routeUnlockId) ? routeUnlockId[0] : routeUnlockId;
  const { api, user } = useAuth();
  const [showPurchased, setShowPurchased] = useState(false);
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['viewer-unlock', unlockId, user?.id],
    enabled: Boolean(unlockId && user),
    queryFn: async () => (await api.getViewerUnlock(unlockId)).unlock,
  });
  const detail = detailQuery.data;
  const purchasedSelected = Boolean(detail?.detached || showPurchased);
  const resources = purchasedSelected
    ? detail?.purchasedRevision.resources ?? null
    : detail?.currentResources ?? detail?.purchasedRevision.resources ?? null;
  const selectedRevision = purchasedSelected ? detail?.purchasedRevision : null;
  const activeTitle = selectedRevision?.title ?? detail?.title ?? 'Creator unlock';
  const activeSummary = selectedRevision?.summary
    || selectedRevision?.previewText
    || detail?.summary
    || detail?.previewText
    || 'Reusable creator resources.';
  const activeAccessMode = selectedRevision?.accessMode ?? detail?.accessMode ?? 'free';
  const activePriceUsdCents = selectedRevision?.priceUsdCents ?? detail?.priceUsdCents ?? 0;
  const activeVersionPrice = activeAccessMode === 'free' ? 'Free' : `${activePriceUsdCents} credits`;
  const activeMediaItems = selectedRevision?.mediaItems ?? detail?.mediaItems ?? [];

  const resolveResourceFileUrl = async (storagePath: string) => {
    if (!unlockId) throw new Error('Missing unlock identity.');
    return (await api.getViewerUnlockFileUrl(unlockId, storagePath)).signedUrl;
  };

  const openResourceFile = async ({ storagePath }: { storagePath: string }) => {
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

  if (!user) {
    return (
      <Screen>
        <SectionTitle eyebrow="Your unlock" title="Sign in to open this unlock." body="Only the buyer account can access retained resources." />
        <PrimaryButton label="Sign in" onPress={() => router.push('/auth')} accent="primary" />
      </Screen>
    );
  }

  return (
    <Screen>
      <SectionTitle
        eyebrow="Your unlock"
        title={activeTitle}
        body={detail ? `by ${detail.creatorDisplayName}` : 'Loading your purchased resources.'}
      />

      {detailQuery.isLoading ? <DetailSkeleton label="Loading your unlock" /> : null}
      {detailQuery.error ? (
        <View style={{ gap: appTheme.spacing.gap }}>
          <StatusBlock tone="danger" title="Unlock unavailable" body="It may have been removed by moderation, or belong to another account." />
          <SecondaryButton label="Try again" onPress={() => void detailQuery.refetch()} />
        </View>
      ) : null}

      {detail ? (
        <>
          <Card accent={activeAccessMode === 'free' ? 'workflow' : 'commerce'}>
            <MediaPreview url={detail.post?.mediaUrl ?? null} kind={detail.post?.mediaKind ?? null} />
            <View style={{ gap: appTheme.spacing.compact }}>
              <Pill
                label={detail.purchasePriceUsdCents > 0 ? `${detail.purchasePriceUsdCents} credits paid` : 'Free unlock'}
                accent={activeAccessMode === 'free' ? 'workflow' : 'commerce'}
              />
              <AppText variant="caption" color="faint">
                {purchasedSelected ? `Purchased version ${detail.purchasedRevision.revisionNumber}` : 'Latest version'} · {activeVersionPrice}
              </AppText>
              <AppText variant="body" color="text">{activeSummary}</AppText>
              {detail.detached ? (
                <AppText variant="bodySm" color="muted">The creator deleted their account. Your purchased version and files are retained.</AppText>
              ) : detail.tombstoned || detail.retired ? (
                <AppText variant="bodySm" color="muted">This listing is no longer available, but your access remains.</AppText>
              ) : null}
            </View>
          </Card>

          <Card accent="workflow">
            <View style={{ gap: 4 }}>
              <AppText variant="cardTitle">Unlocked resources</AppText>
              <AppText variant="caption" color="faint">
                {purchasedSelected ? `Purchased version ${detail.purchasedRevision.revisionNumber}` : 'Latest version'}
              </AppText>
            </View>

            {detail.hasNewerRevision && detail.currentResources ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[
                  { label: 'Latest', selected: !showPurchased, onPress: () => setShowPurchased(false) },
                  { label: 'Purchased', selected: showPurchased, onPress: () => setShowPurchased(true) },
                ].map((option) => (
                  <Pressable
                    accessibilityLabel={`Show ${option.label.toLowerCase()} unlock version`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: option.selected }}
                    key={option.label}
                    onPress={option.onPress}
                    style={({ pressed }) => ({
                      borderRadius: appTheme.radii.pill,
                      borderWidth: 1,
                      borderColor: option.selected ? appTheme.colors.success : appTheme.colors.border,
                      backgroundColor: option.selected ? `${appTheme.colors.success}20` : appTheme.colors.surface,
                      opacity: pressed ? appTheme.opacity.pressed : 1,
                      paddingHorizontal: 14,
                      paddingVertical: 9,
                    })}
                  >
                    <AppText variant="caption" color={option.selected ? 'success' : 'muted'}>{option.label}</AppText>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <PostResourceBundleContent
              fileLoadingPath={fileLoadingPath}
              mediaItems={activeMediaItems}
              onCopy={async (text) => {
                await Clipboard.setStringAsync(text);
              }}
              onError={setResourceError}
              onOpenFile={openResourceFile}
              onOpenUrl={(url) => Linking.openURL(url)}
              resolveFileUrl={resolveResourceFileUrl}
              resources={resources}
            />
            {resourceError ? <StatusBlock tone="danger" title="Resource unavailable" body={resourceError} /> : null}
          </Card>

          {detail.postId && !detail.tombstoned ? (
            <SecondaryButton label="View original post" onPress={() => router.push(`/showcase/${detail.postId}` as never)} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
