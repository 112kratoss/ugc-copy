import { Lock, MessageCircle, Repeat2, ShoppingBag } from 'lucide-react-native';
import { memo, useCallback, useContext } from 'react';
import { Pressable, Text } from 'react-native';

import { FeedCardAction, FeedCardShell } from '@/components/feed-card-shell';
import { NativeMenu } from '@/components/native-menu';
import { MediaZoomSourceView, useMediaZoomSource } from '@/components/media-zoom';
import { FEED_CARD_MEDIA_RADIUS, feedCardMediaWidth } from '@/lib/feed-card-geometry';
import type { AppleZoomOpen } from '@/lib/apple-zoom';
import { FeedVideoActivationContext, useFeedVideoActivation } from '@/lib/feed-video-activation';
import { PostReadMore, PostTextBlock } from '@/components/post-text-block';
import { SaveHeart } from '@/components/save-heart';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import {
  canExpandHomeFeedBody,
  getHomeFeedMediaHeight,
  type HomeFeedCard,
} from '@/lib/home-feed-view-model';
import { verticalHitSlop } from '@/lib/hit-target';
import { cardUnlock } from '@/lib/showcase-feed-view-model';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { showcaseMediaZoomPreview } from '@/lib/media-zoom-transition';
import { buildImmersiveShowcaseItems } from '@/lib/immersive-preview-view-model';
import type { NativeMenuModel } from '@/lib/native-menu';
import { getShowcasePreviewMediaItems } from '@/lib/showcase-media';
import { accentColor, appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export const HomeFeedCardView = memo(function HomeFeedCardView({
  card,
  contentWidth,
  onOpen,
  onReadMore,
  onFeedbackOpen,
  feedbackMenu,
  onCreatorOpen,
  onSave,
  onComments,
  onRemix,
  onShare,
  onAssetPress,
  remixLoading,
}: {
  card: HomeFeedCard;
  contentWidth: number;
  /** Opens the post, carrying the zoom the tile hands the push on iOS 18 (lib/apple-zoom.ts). */
  onOpen: (zoom: AppleZoomOpen | null) => void;
  onReadMore: () => void;
  onFeedbackOpen: () => void;
  /** The ⋮ menu; `onFeedbackOpen` opens the sheet where native menus are missing. */
  feedbackMenu: NativeMenuModel;
  onCreatorOpen: () => void;
  onSave: () => void;
  onComments: () => void;
  onRemix: () => void;
  onShare: () => void;
  /** Opens the post's details, where the recipe or unlock is. */
  onAssetPress?: () => void;
  remixLoading?: boolean;
}) {
  const theme = useAppTheme();
  const accent = accentColor(card.accent, theme.colors);
  const hasMedia = card.previewKind !== 'text' && Boolean(card.mediaUrl);
  const unlockRow = card.item.asset ? cardUnlock(card.item) : null;
  // The inset media and measured zoom source keep exactly the same width.
  const mediaWidth = feedCardMediaWidth(contentWidth);
  const mediaHeight = hasMedia ? getHomeFeedMediaHeight(card, mediaWidth) : 0;
  const bodyWidth = mediaWidth;
  // Subscribed per card, so an election re-renders this card and no other,
  // and the list never re-renders for playback (lib/feed-video-activation.ts).
  const activationStore = useContext(FeedVideoActivationContext);
  const videoActivation = useFeedVideoActivation(activationStore, card.id);
  const reportVideoReady = useCallback(
    (ready: boolean) => activationStore?.setReady(card.id, ready),
    [activationStore, card.id],
  );
  // The media is what opens: the reel grows out of this rectangle, carrying
  // this picture, and shrinks back into it when the reader comes back.
  const mediaItems = getShowcasePreviewMediaItems(card.item);
  const zoomSource = useMediaZoomSource({
    radius: FEED_CARD_MEDIA_RADIUS,
    itemId: card.item.id,
    aspectRatio: card.aspectRatio ?? null,
    preview: showcaseMediaZoomPreview(mediaItems[0]),
    // The post as the reel lists it, so the window it grows in carries its rail
    // and caption from the first frame.
    post: buildImmersiveShowcaseItems('showcase-feed', [card.item])[0] ?? null,
    enabled: hasMedia,
  });

  return (
    <FeedCardShell
      categoryLabel={card.categoryLabel}
      creatorAvatar={card.creatorAvatar}
      creatorLabel={card.creatorLabel}
      creatorName={card.creatorName}
      onCreatorPress={onCreatorOpen}
      onMorePress={onFeedbackOpen}
      moreAccessibilityLabel={`More options for ${card.title}`}
      renderMoreMenu={({ trigger, renderButton }) => (
        <NativeMenu
          model={feedbackMenu}
          accessibilityLabel={`More options for ${card.title}`}
          trigger={trigger}
          onFallbackPress={onFeedbackOpen}
          renderButton={renderButton}
        />
      )}
      onOpen={() => zoomSource.capture(onOpen)}
      onOpenTouchStart={zoomSource.prepare}
      nativeZoom={Boolean(zoomSource.appleZoomId)}
      openAccessibilityLabel={`Open ${card.title}`}
      timeLabel={card.timeLabel}
      title={card.title}
      body={card.bodyText ? (
        <PostTextBlock
          text={card.bodyText}
          clampLines={card.bodyLines}
        />
      ) : null}
      readMore={card.bodyText && canExpandHomeFeedBody(card, bodyWidth)
        ? <PostReadMore onPress={onReadMore} />
        : null}
      unlock={unlockRow ? (
        // Sellable posts were invisible while scrolling: the web card names the
        // recipe and its price; the app's card showed only the category.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${unlockRow.label}: ${card.item.asset?.title ?? 'recipe'}`}
          onPress={onAssetPress}
          disabled={!onAssetPress}
          hitSlop={verticalHitSlop(40)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 40,
            marginTop: appTheme.spacing.compact,
            paddingHorizontal: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.panelSoft,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <ShoppingBag size={appTheme.icon.compact} color={theme.colors.text} />
          <Text numberOfLines={1} style={{ color: theme.colors.text, ...appTheme.type.label, flexShrink: 0 }}>
            {unlockRow.label}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.muted, ...appTheme.type.caption, flexShrink: 1 }}>
            {card.item.asset?.title}
          </Text>
        </Pressable>
      ) : null}
      media={hasMedia ? (
        <MediaZoomSourceView source={zoomSource}>
          <ShowcaseMediaPreview
            accent={accent}
            mediaItems={mediaItems}
            width={mediaWidth}
            height={mediaHeight}
            radius={FEED_CARD_MEDIA_RADIUS}
            recyclingKey={`home-feed:${card.id}`}
            videoActivation={videoActivation}
            onVideoReadyChange={reportVideoReady}
            videoBackdrop="none"
            videoContentFit="cover"
          />
        </MediaZoomSourceView>
      ) : null}
      actions={(
        <>
          <FeedCardAction
            accessibilityLabel={card.isSaved ? `Remove ${card.title} from saved` : `Save ${card.title}`}
            icon={<SaveHeart saved={card.isSaved} size={appTheme.icon.compact} />}
            label={card.saveLabel}
            onPress={onSave}
          />
          <FeedCardAction
            accessibilityLabel={`Comments on ${card.title}`}
            icon={<MessageCircle size={appTheme.icon.compact} color={theme.colors.faint} />}
            label={card.commentLabel}
            onPress={onComments}
          />
          {/* Drawn for every post that can be remixed, whoever is looking: the
              tap takes a free unlock on its way, and a paid one opens its sheet,
              which the lock says before the tap. */}
          {card.remixAccess ? (
            <FeedCardAction
              accessibilityLabel={card.remixAccessibilityLabel}
              icon={card.remixAccess === 'paid-unlock'
                ? <Lock size={appTheme.icon.compact} color={theme.colors.faint} />
                : <Repeat2 size={appTheme.icon.compact} color={theme.colors.faint} />}
              label={card.remixLabel}
              loading={remixLoading}
              onPress={onRemix}
            />
          ) : null}
          <FeedCardAction
            accessibilityLabel={`Share ${card.title}`}
            icon={<ShareGlyph size={appTheme.icon.compact} color={theme.colors.faint} />}
            onPress={onShare}
          />
        </>
      )}
    />
  );
});
