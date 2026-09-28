import { memo } from 'react';
import { Pressable, Text } from 'react-native';

import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The body of a feed post — the same muted, clamped paragraph for every kind.
 *
 * A text post used to get a framed panel with an accent rail, on the theory
 * that it had to read as something written. It reads that way anyway: the
 * title carries it, and the card is now a tap away from the post itself.
 *
 * The preview text stays clamped; the separate Read more button can open the
 * full story without sharing the preview's touch target.
 */
export const PostTextBlock = memo(function PostTextBlock({
  text,
  clampLines,
}: {
  text: string;
  clampLines: number;
}) {
  const theme = useAppTheme();
  if (!text) return null;

  return (
    <Text
      numberOfLines={clampLines}
      style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}
    >
      {text}
    </Text>
  );
});

export function PostReadMore({ onPress }: { onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Read more"
      accessibilityHint="Opens the full text"
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        minHeight: 44,
        justifyContent: 'center',
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <Text style={{ color: theme.colors.primary, ...appTheme.type.caption, fontWeight: '800' }}>
        Read more
      </Text>
    </Pressable>
  );
}
