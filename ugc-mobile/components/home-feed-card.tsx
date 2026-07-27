import { Heart, MessageCircle, MoreVertical, Repeat2, Share2 } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { PostTextBlock } from '@/components/post-text-block';
import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { CreatorAvatar } from '@/components/ui';
import {
  canExpandHomeFeedBody,
  getHomeFeedMediaHeight,
  isFramedHomeFeedBody,
  type HomeFeedCard,
} from '@/lib/home-feed-view-model';
import { accentColor, appTheme } from '@/lib/theme';
import { getSaveHeartIconProps } from '@/lib/viewer-actions';

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
}) {
  const accent = accentColor(card.accent);
  const hasMedia = card.previewKind !== 'text' && Boolean(card.mediaUrl);
  const mediaHeight = hasMedia ? getHomeFeedMediaHeight(card, contentWidth) : 0;
  const framedBody = isFramedHomeFeedBody(card);
  const bodyWidth = contentWidth - appTheme.spacing.card * 2;

  return (
    <View
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        overflow: 'hidden',
      }}
    >
      {/*
        Reddit's hierarchy: a thin attribution line, then the title as the
        loudest thing on the card. The creator is context, not the headline.
      */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.compact,
          paddingHorizontal: appTheme.spacing.card,
          paddingTop: appTheme.spacing.gap,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${card.creatorLabel}`}
          onPress={onCreatorOpen}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            flex: 1,
            minHeight: 32,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <CreatorAvatar uri={card.creatorAvatar} name={card.creatorName} size={22} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
            {card.creatorLabel}
          </Text>
          <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
            {`· ${card.timeLabel}`}
          </Text>
        </Pressable>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: `${accent}44`,
            backgroundColor: `${accent}1a`,
          }}
        >
          <Text style={{ color: accent, ...appTheme.type.caption, fontSize: 11, fontWeight: '800' }}>
            {card.categoryLabel}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More options for ${card.title}`}
          hitSlop={10}
          onPress={onFeedbackOpen}
          style={{ width: 28, height: 32, alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <MoreVertical size={17} color={appTheme.colors.faint} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${card.title}`}
        onPress={onOpen}
        style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <View
          style={{
            paddingHorizontal: appTheme.spacing.card,
            paddingTop: appTheme.spacing.compact,
            paddingBottom: card.bodyText || hasMedia ? appTheme.spacing.gap : appTheme.spacing.compact,
            gap: appTheme.spacing.compact,
          }}
        >
          <Text numberOfLines={3} style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontSize: 19, lineHeight: 25 }}>
            {card.title}
          </Text>
          {card.bodyText ? (
            <PostTextBlock
              accent={accent}
              text={card.bodyText}
              clampLines={card.bodyLines}
              canExpand={canExpandHomeFeedBody(card, bodyWidth)}
              expanded={bodyExpanded}
              framed={framedBody}
              onToggle={onToggleBody}
            />
          ) : null}
        </View>

        {hasMedia ? (
          <ShowcaseMediaPreview
            accent={accent}
            item={card.item}
            width={contentWidth}
            height={mediaHeight}
            radius={0}
            recyclingKey={`home-feed:${card.id}`}
            videoActivation={showActiveVideo ? 'visible' : 'never'}
            videoBackdrop="none"
            videoContentFit="cover"
          />
        ) : null}
      </Pressable>

      {card.unlock ? (
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

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: appTheme.spacing.compact,
          paddingVertical: appTheme.spacing.compact,
        }}
      >
        <CardAction
          accessibilityLabel={card.isSaved ? `Remove ${card.title} from saved` : `Save ${card.title}`}
          icon={<Heart size={19} {...getSaveHeartIconProps({ isSaved: card.isSaved, enabled: true })} />}
          label={card.saveLabel}
          onPress={onSave}
        />
        <CardAction
          accessibilityLabel={`Comments on ${card.title}`}
          icon={<MessageCircle size={19} color={appTheme.colors.faint} strokeWidth={2.2} />}
          label={card.commentLabel}
          onPress={onComments}
        />
        {card.canRemix ? (
          <CardAction
            accessibilityLabel={`Remix ${card.title}`}
            icon={<Repeat2 size={19} color={appTheme.colors.faint} strokeWidth={2.2} />}
            label={card.remixLabel}
            onPress={onRemix}
          />
        ) : null}
        <CardAction
          accessibilityLabel={`Share ${card.title}`}
          icon={<Share2 size={18} color={appTheme.colors.faint} strokeWidth={2.2} />}
          onPress={onShare}
        />
      </View>
    </View>
  );
});

function CardAction({
  accessibilityLabel,
  icon,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  icon: React.ReactNode;
  label?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: appTheme.spacing.compact,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {icon}
      {label ? (
        <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption, fontWeight: '800' }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
