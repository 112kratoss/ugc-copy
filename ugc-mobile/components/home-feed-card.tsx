import { MessageCircle, Repeat2 } from 'lucide-react-native';
import { memo } from 'react';
import { Text, View } from 'react-native';

import { FeedCardAction, FeedCardShell } from '@/components/feed-card-shell';
import { PostTextBlock } from '@/components/post-text-block';
import { SaveHeart } from '@/components/save-heart';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import {
  canExpandHomeFeedBody,
  getHomeFeedMediaHeight,
  type HomeFeedCard,
} from '@/lib/home-feed-view-model';
import { ShareGlyph } from '@/lib/platform-glyphs';
import { getShowcasePreviewMediaItems } from '@/lib/showcase-media';
import { accentColor, appTheme } from '@/lib/theme';

export const HomeFeedCardView = memo(function HomeFeedCardView({
  card,
  contentWidth,
  showActiveVideo,
  bodyExpanded,
  onOpen,
  onToggleBody,
  onFeedbackOpen,
  onCreatorOpen,
  onSave,
  onComments,
  onRemix,
  onShare,
  remixLoading,
}: {
  card: HomeFeedCard;
  contentWidth: number;
  showActiveVideo: boolean;
  bodyExpanded: boolean;
  onOpen: () => void;
  onToggleBody: () => void;
  onFeedbackOpen: () => void;
  onCreatorOpen: () => void;
  onSave: () => void;
  onComments: () => void;
  onRemix: () => void;
  onShare: () => void;
  remixLoading?: boolean;
}) {
  const accent = accentColor(card.accent);
  const hasMedia = card.previewKind !== 'text' && Boolean(card.mediaUrl);
  const mediaHeight = hasMedia ? getHomeFeedMediaHeight(card, contentWidth) : 0;
  const bodyWidth = contentWidth - appTheme.spacing.card * 2;

  return (
    <FeedCardShell
      accent={accent}
      categoryLabel={card.categoryLabel}
      creatorAvatar={card.creatorAvatar}
      creatorLabel={card.creatorLabel}
      creatorName={card.creatorName}
      onCreatorPress={onCreatorOpen}
      onMorePress={onFeedbackOpen}
      moreAccessibilityLabel={`More options for ${card.title}`}
      onOpen={onOpen}
      openAccessibilityLabel={`Open ${card.title}`}
      timeLabel={card.timeLabel}
      title={card.title}
      body={card.bodyText ? (
        <PostTextBlock
          text={card.bodyText}
          clampLines={card.bodyLines}
          canExpand={canExpandHomeFeedBody(card, bodyWidth)}
          expanded={bodyExpanded}
          onToggle={onToggleBody}
        />
      ) : null}
      media={hasMedia ? (
        <ShowcaseMediaPreview
          accent={accent}
          mediaItems={getShowcasePreviewMediaItems(card.item)}
          width={contentWidth}
          height={mediaHeight}
          radius={0}
          recyclingKey={`home-feed:${card.id}`}
          videoActivation={showActiveVideo ? 'visible' : 'never'}
          videoBackdrop="none"
          videoContentFit="cover"
        />
      ) : null}
      banner={card.unlock ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: appTheme.spacing.compact,
            marginHorizontal: appTheme.spacing.card,
            marginTop: appTheme.spacing.gap,
            paddingHorizontal: appTheme.spacing.gap,
            paddingVertical: appTheme.spacing.compact,
            borderRadius: appTheme.radii.sm,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: `${accentColor(card.unlock.accent)}55`,
            backgroundColor: `${accentColor(card.unlock.accent)}1f`,
          }}
        >
          <Text style={{ color: accentColor(card.unlock.accent), ...appTheme.type.caption, fontWeight: '800' }}>
            {card.unlock.label}
          </Text>
          <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption, flex: 1 }}>
            {card.unlock.summary}
          </Text>
        </View>
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
            icon={<MessageCircle size={appTheme.icon.compact} color={appTheme.colors.faint} />}
            label={card.commentLabel}
            onPress={onComments}
          />
          {card.canRemix ? (
            <FeedCardAction
              accessibilityLabel={`Remix ${card.title}`}
              icon={<Repeat2 size={appTheme.icon.compact} color={appTheme.colors.faint} />}
              label={card.remixLabel}
              loading={remixLoading}
              onPress={onRemix}
            />
          ) : null}
          <FeedCardAction
            accessibilityLabel={`Share ${card.title}`}
            icon={<ShareGlyph size={appTheme.icon.compact} color={appTheme.colors.faint} />}
            onPress={onShare}
          />
        </>
      )}
    />
  );
});
