import { Heart, MessageCircle, MoreVertical, Repeat2, Share2 } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ShowcaseMediaPreview } from '@/components/showcase-media-preview';
import { CreatorAvatar } from '@/components/ui';
import { getHomeFeedMediaHeight, type HomeFeedCard } from '@/lib/home-feed-view-model';
import { accentColor, appTheme } from '@/lib/theme';
import { getSaveHeartIconProps } from '@/lib/viewer-actions';

export const HomeFeedCardView = memo(function HomeFeedCardView({
  card,
  contentWidth,
  showActiveVideo,
  onOpen,
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
  onOpen: () => void;
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
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.compact,
          paddingHorizontal: appTheme.spacing.card,
          paddingTop: appTheme.spacing.card,
          paddingBottom: appTheme.spacing.compact,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${card.creatorLabel}`}
          onPress={onCreatorOpen}
          style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact, flex: 1 }}
        >
          <CreatorAvatar uri={card.creatorAvatar} name={card.creatorName} size={32} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text numberOfLines={1} style={{ color: appTheme.colors.text, ...appTheme.type.label, fontWeight: '800' }}>
              {card.creatorLabel}
            </Text>
            <Text numberOfLines={1} style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
              {`${card.categoryLabel} · ${card.timeLabel}`}
            </Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More options for ${card.title}`}
          hitSlop={10}
          onPress={onFeedbackOpen}
          style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
        >
          <MoreVertical size={18} color={appTheme.colors.faint} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${card.title}`}
        onPress={onOpen}
        style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <View style={{ paddingHorizontal: appTheme.spacing.card, gap: 5, paddingBottom: appTheme.spacing.gap }}>
          <Text numberOfLines={2} style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}>
            {card.title}
          </Text>
          {card.bodyText ? (
            <Text
              numberOfLines={card.bodyLines}
              style={{ color: appTheme.colors.textSecondary, ...appTheme.type.bodySm }}
            >
              {card.bodyText}
            </Text>
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
        ) : (
          <View
            style={{
              marginHorizontal: appTheme.spacing.card,
              marginBottom: appTheme.spacing.gap,
              height: 3,
              width: 44,
              borderRadius: 2,
              backgroundColor: accent,
            }}
          />
        )}
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
