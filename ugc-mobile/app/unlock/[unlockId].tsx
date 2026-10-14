import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Play } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { MatureCover } from '@/components/mature-cover';
import { MediaPreview } from '@/components/media-preview';
import { PostResourceBundleContent, ResourceRevisionSwitch } from '@/components/post-resource-bundle-content';
import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';
import { DetailSkeleton } from '@/components/skeleton';
import { AppText, Card, Pill, PrimaryButton, Screen, SecondaryButton, SectionTitle, StatusBlock } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { appTheme, mediaColors } from '@/lib/theme';
import { ThemeScope } from '@/lib/theme-context';
import type { ShowcaseMediaItem } from '@/lib/types';
import {
  canOpenUnlockedPost,
  describeUnreachableUnlockedPost,
  formatUnlockPaidPill,
  formatUnlockPrice,
  getUnlockCover,
  type UnlockCover,
} from '@/lib/unlock-library-view-model';

const NO_MEDIA_ITEMS: ShowcaseMediaItem[] = [];

export default function ViewerUnlockScreen() {
  const { unlockId: routeUnlockId } = useLocalSearchParams<{ unlockId: string }>();
  const unlockId = Array.isArray(routeUnlockId) ? routeUnlockId[0] : routeUnlockId;
  const { api, user } = useAuth();
  const [showPurchased, setShowPurchased] = useState(false);
  const [matureShown, setMatureShown] = useState(false);
  const [fileLoadingPath, setFileLoadingPath] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['viewer-unlock', unlockId, user?.id],
    enabled: Boolean(unlockId && user),
    queryFn: async () => (await api.getViewerUnlock(unlockId)).unlock,
  });
  const detail = detailQuery.data;
  // A refresh that fails leaves the unlock on screen; only one that never
  // loaded is a failure to show.
  const loadError = detail ? null : detailQuery.error;
  // A 404 is the unlock itself being gone, which no retry brings back; anything
  // else (offline, a 500, a 429) is the connection, and says so.
  const unlockGone = loadError instanceof ApiError && loadError.status === 404;
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
  const activeVersionPrice = activeAccessMode === 'free' ? 'Free' : formatUnlockPrice(activePriceUsdCents);
  const activeMediaItems = selectedRevision?.mediaItems ?? detail?.mediaItems ?? [];
  const cover = getUnlockCover(detail?.post ?? null);
  // The plate stands in the cover's place whenever there is mature media to
  // keep back, the outputs' thumbnails included, so Show is always on screen.
  const matureCovered = Boolean(detail?.isNsfw)
    && !matureShown
    && (cover.kind !== 'none' || activeMediaItems.length > 0);

  // Memoized: every reference preview signs through this, and the previews
  // one render mounts are signed together in one request. Inline, so a file
  // the browser can show opens rather than downloads.
  const resolveResourceFileUrl = useCallback(async (storagePath: string) => {
    if (!unlockId) throw new Error('Missing unlock identity.');
    return api.resolveViewerUnlockFileUrl(unlockId, storagePath, { disposition: 'inline' });
  }, [api, unlockId]);

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
        <PrimaryButton
          label="Sign in"
          onPress={() => router.push({
            pathname: '/auth',
            params: { returnTo: `/unlock/${encodeURIComponent(String(unlockId ?? ''))}` },
          } as never)}
          accent="primary"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <SectionTitle
        eyebrow="Your unlock"
        title={activeTitle}
        body={detail
          ? `by ${detail.creatorDisplayName}`
          : loadError
            ? 'This unlock could not be opened.'
            : 'Loading your purchased resources.'}
      />

      {detailQuery.isLoading ? <DetailSkeleton label="Loading your unlock" /> : null}
      {loadError ? (
        unlockGone ? (
          <StatusBlock title="Unlock unavailable" body="It may have been removed by moderation, or belong to another account." />
        ) : (
          <View style={{ gap: appTheme.spacing.gap }}>
            <StatusBlock tone="danger" title="Could not load your unlock" body="Check your connection, then try again." />
            <SecondaryButton label="Retry" onPress={() => void detailQuery.refetch()} />
          </View>
        )
      ) : null}

      {detail ? (
        <>
          <Card accent={activeAccessMode === 'free' ? 'workflow' : 'commerce'}>
            <UnlockCoverMedia
              cover={cover}
              covered={matureCovered}
              onShow={() => setMatureShown(true)}
            />
            <View style={{ gap: appTheme.spacing.compact }}>
              <Pill
                label={formatUnlockPaidPill(detail)}
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
              ) : !canOpenUnlockedPost(detail) ? (
                <AppText variant="bodySm" color="muted">{describeUnreachableUnlockedPost(detail)}</AppText>
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
              <View style={{ gap: appTheme.spacing.compact }}>
                {/* Why there are two versions, as the post's resources card says it. */}
                <AppText variant="bodySm" color="muted">
                  The creator has updated this unlock since you bought it. You can read either version.
                </AppText>
                <ResourceRevisionSwitch
                  selected={showPurchased ? 'purchased' : 'latest'}
                  onSelect={(revision) => setShowPurchased(revision === 'purchased')}
                />
              </View>
            ) : null}

            <PostResourceBundleContent
              fileLoadingPath={fileLoadingPath}
              // The outputs' own thumbnails, which pick a resource's scope: a
              // covered mature post draws none of them until it is shown.
              mediaItems={matureCovered ? NO_MEDIA_ITEMS : activeMediaItems}
              onCopy={(text) => copyToClipboard(text)}
              onError={setResourceError}
              onOpenFile={openResourceFile}
              onOpenUrl={(url) => Linking.openURL(url)}
              resolveFileUrl={resolveResourceFileUrl}
              resources={resources}
            />
            {resourceError ? <StatusBlock tone="danger" title="Resource unavailable" body={resourceError} /> : null}
          </Card>

          {canOpenUnlockedPost(detail) ? (
            <SecondaryButton label="View original post" onPress={() => router.push(`/showcase/${detail.postId}` as never)} />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** The 4:5 card `MediaPreview` draws a clip in, so the player takes the still's place exactly. */
const COVER_VIDEO_FRAME = {
  width: '100%' as const,
  aspectRatio: 4 / 5,
  borderRadius: appTheme.radii.lg,
  backgroundColor: mediaColors.mediaGround,
};
const PLAY_CONTROL_SIZE = 64;

/**
 * The post's still, and for a video the player only once Play is pressed: the
 * cover used to be a player of the original, which downloads a whole clip as
 * the unlock opens.
 */
function UnlockCoverMedia({
  cover,
  covered,
  onShow,
}: {
  cover: UnlockCover;
  covered: boolean;
  onShow: () => void;
}) {
  const [playing, setPlaying] = useState(false);

  if (covered) return <MatureCover variant="card" onShow={onShow} />;
  if (cover.kind === 'none') return <MediaPreview url={null} />;
  if (cover.kind === 'image') return <MediaPreview url={cover.stillUrl} kind="image" />;

  if (playing) {
    // The press was the request to play, so the clip starts without a second one.
    return (
      <ThemeScope scheme="dark">
        <RecoverableVideoPreview url={cover.videoUrl} autoPlay nativeControls style={COVER_VIDEO_FRAME} />
      </ThemeScope>
    );
  }

  return (
    <View>
      {cover.stillUrl ? <MediaPreview url={cover.stillUrl} kind="image" /> : <View style={COVER_VIDEO_FRAME} />}
      <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Play video"
          onPress={() => setPlaying(true)}
          style={({ pressed }) => ({
            width: PLAY_CONTROL_SIZE,
            height: PLAY_CONTROL_SIZE,
            borderRadius: PLAY_CONTROL_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mediaColors.mediaChip,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {/* A triangle's visual centre sits left of its box. */}
          <Play size={appTheme.icon.feature} color={mediaColors.onMedia} fill={mediaColors.onMedia} style={{ marginLeft: 2 }} />
        </Pressable>
      </View>
    </View>
  );
}
