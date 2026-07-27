import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { TEXT_PANEL_PADDING, TEXT_PANEL_RAIL_WIDTH } from '@/lib/home-feed-view-model';
import { appTheme } from '@/lib/theme';

/**
 * The body of a feed post.
 *
 * A text post is the whole post, so it gets a framed panel with an accent rail
 * — it has to read as something written, not as a media card whose preview
 * failed to load. Every other kind captions its media, so the same body renders
 * unframed and one size down.
 *
 * `expanded` is owned by the list, not by this component: FlashList recycles
 * card views, and local state would follow a recycled view onto an unrelated
 * post.
 */
export const PostTextBlock = memo(function PostTextBlock({
  accent,
  text,
  clampLines,
  canExpand,
  expanded,
  framed,
  onToggle,
}: {
  accent: string;
  text: string;
  clampLines: number;
  canExpand: boolean;
  expanded: boolean;
  framed: boolean;
  onToggle: () => void;
}) {
  if (!text) return null;

  const body = (
    <Text
      numberOfLines={expanded ? undefined : clampLines}
      selectable={framed}
      style={{
        color: framed ? appTheme.colors.textSecondary : appTheme.colors.muted,
        ...(framed ? appTheme.type.body : appTheme.type.bodySm),
      }}
    >
      {text}
    </Text>
  );

  const readMore = canExpand ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Show less' : 'Read more'}
      accessibilityState={{ expanded }}
      hitSlop={6}
      onPress={onToggle}
      style={({ pressed }) => ({
        minHeight: 32,
        justifyContent: 'center',
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <Text style={{ color: appTheme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
        {expanded ? 'Show less' : 'Read more'}
      </Text>
    </Pressable>
  ) : null;

  if (!framed) {
    return (
      <View style={{ gap: 2 }}>
        {body}
        {readMore}
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        borderRadius: appTheme.radii.sm,
        borderCurve: 'continuous',
        backgroundColor: appTheme.colors.surface,
        overflow: 'hidden',
      }}
    >
      <View style={{ width: TEXT_PANEL_RAIL_WIDTH, backgroundColor: accent }} />
      <View
        style={{
          flex: 1,
          gap: 4,
          paddingHorizontal: TEXT_PANEL_PADDING,
          paddingVertical: appTheme.spacing.gap,
        }}
      >
        {body}
        {readMore}
      </View>
    </View>
  );
});
