import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';

/**
 * The body of a feed post — the same muted, clamped paragraph for every kind.
 *
 * A text post used to get a framed panel with an accent rail, on the theory
 * that it had to read as something written. It reads that way anyway: the
 * title carries it, and the card is now a tap away from the post itself.
 *
 * `expanded` is owned by the list, not by this component: FlashList recycles
 * card views, and local state would follow a recycled view onto an unrelated
 * post.
 */
export const PostTextBlock = memo(function PostTextBlock({
  text,
  clampLines,
  canExpand,
  expanded,
  onToggle,
}: {
  text: string;
  clampLines: number;
  canExpand: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!text) return null;

  return (
    <View style={{ gap: 2 }}>
      <Text
        // `canExpand` is part of the condition, not just `expanded`: the list's
        // expanded ids survive a refetch, so a card that stops offering the
        // toggle would otherwise be stuck unclamped with no way to collapse.
        numberOfLines={expanded && canExpand ? undefined : clampLines}
        style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}
      >
        {text}
      </Text>
      {canExpand ? (
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
      ) : null}
    </View>
  );
});
