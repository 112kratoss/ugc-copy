import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { TextPostPlateContent } from '@/lib/text-post-plate-view-model';
import { useAppTheme } from '@/lib/theme-context';

/** A tile's title line plus the gap under it, for `textPostPlateBodyLines`. */
export const TEXT_POST_PLATE_TITLE_HEIGHT = 20;
export const TEXT_POST_PLATE_BODY_LINE_HEIGHT = 16;
/** The line height of a `feature` plate's writing: a frame as large as a picture tile's. */
export const TEXT_POST_PLATE_FEATURE_LINE_HEIGHT = 20;

/**
 * A text post where a picture would be: a quiet page with a rule down its
 * leading edge, the post's name, then its writing. One look for the search
 * results, a creator's grid and the profile grid, which is also the reel's
 * text slide in small (`TextSlide`, app/viewer.tsx), so a post reads as the
 * same thing wherever it turns up.
 *
 * It fills its parent. The paddings are props because each grid keeps marks in
 * different corners (a type mark above, a state mark below, a recipe chip).
 *
 * Two sizes. `tile` is the profile grid's small square: a name, then the
 * writing in a quieter line, from the top. `feature` is a frame the size of a
 * picture tile (search, a creator's grid): the writing in a larger line, set
 * at the foot of the frame, where it sits against the caption that names it.
 * Set from the top, three lines of a short note left most of the frame empty.
 */
export function TextPostPlate({
  content,
  accent,
  bodyLines,
  size = 'tile',
  paddingTop = 14,
  paddingBottom = 14,
  style,
  testID,
}: {
  content: TextPostPlateContent;
  /** The rule's colour; coral for a post, as on the reel's slide. */
  accent?: string;
  /** Whole lines of writing the plate has room for. */
  bodyLines: number;
  size?: 'tile' | 'feature';
  paddingTop?: number;
  paddingBottom?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useAppTheme();
  const { title, body } = content;
  const feature = size === 'feature';

  return (
    <View
      testID={testID}
      style={[{ flex: 1, overflow: 'hidden', justifyContent: feature ? 'flex-end' : 'flex-start', backgroundColor: theme.colors.surfaceInset, paddingLeft: feature ? 17 : 15, paddingRight: feature ? 14 : 12, paddingTop, paddingBottom }, style]}
    >
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent ?? theme.colors.primary }} />
      {title ? (
        <Text
          // Alone on the plate, the title is the whole tile and may run on.
          numberOfLines={body ? 1 : bodyLines}
          style={{ color: theme.colors.text, fontSize: feature ? 15 : 13, lineHeight: feature ? TEXT_POST_PLATE_FEATURE_LINE_HEIGHT : 17, fontWeight: '800', marginBottom: body ? TEXT_POST_PLATE_TITLE_HEIGHT - 17 : 0 }}
        >
          {title}
        </Text>
      ) : null}
      {body ? (
        <Text
          numberOfLines={bodyLines}
          // Under a title the writing steps back; alone, it is the tile.
          style={feature
            ? { color: theme.colors.text, fontSize: 15, lineHeight: TEXT_POST_PLATE_FEATURE_LINE_HEIGHT, fontWeight: '700' }
            : { color: title ? theme.colors.muted : theme.colors.textSecondary, fontSize: title ? 12 : 13, lineHeight: TEXT_POST_PLATE_BODY_LINE_HEIGHT, fontWeight: title ? '500' : '600' }}
        >
          {body}
        </Text>
      ) : null}
    </View>
  );
}
