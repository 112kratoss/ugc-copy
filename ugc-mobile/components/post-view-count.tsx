import { Eye } from 'lucide-react-native';
import { Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';

import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ViewCountLabels } from '@/lib/view-count/view-count';

/**
 * A post's views as the app draws them (post view counts, step 3; the web's
 * twin is `src/components/PostViewCount.tsx`): Lucide's `Eye` and the compact
 * figure ("1.2K"). The labels are the shared rule's (`lib/view-count/`), which
 * gives none at 0 and none for a post that is not public, so a caller with no
 * labels draws nothing at all, never "0".
 *
 * A count is information, never an action: no Pressable, no press state, no
 * button role. A screen reader hears the whole number ("1,234 views").
 * The reel's rail draws its own, among its bare icons (`components/reel-chrome.tsx`).
 */

/** In a row of actions (the post page's): as tall as its neighbours, with no border, so it reads as no button. */
export function PostViewCount({
  labels,
  style,
}: {
  labels: ViewCountLabels | null | undefined;
  /** Places the count in its row (an auto margin); never restyles it. */
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useAppTheme();
  if (!labels) return null;
  return (
    <View
      testID="post-view-count"
      accessible
      accessibilityRole="text"
      accessibilityLabel={labels.spoken}
      style={[
        {
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: appTheme.spacing.compact,
        },
        style,
      ]}
    >
      <Eye size={appTheme.icon.compact} color={theme.colors.faint} />
      <Text style={{ color: theme.colors.faint, ...appTheme.type.caption, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
        {labels.compact}
      </Text>
    </View>
  );
}

/** How far a tile's views sit from its bottom left corner. */
export const TILE_VIEW_COUNT_INSET = 8;
/** The chip's height at the default text size. */
const TILE_VIEW_COUNT_HEIGHT = 22;
/** The chip figure's line at the default text size. */
const TILE_VIEW_COUNT_LINE_HEIGHT = 14;
/**
 * How far the chip's figure follows the reader's text size: metadata's cap
 * (`appTheme.typeScale.control`), so the chip stays a chip on a small tile.
 */
const TILE_VIEW_COUNT_MAX_SCALE = appTheme.typeScale.control;

/** The chip's height at the reader's text size (`useWindowDimensions().fontScale`). */
export function tileViewCountChipHeight(fontScale: number): number {
  const scale = Math.min(Math.max(Number.isFinite(fontScale) ? fontScale : 1, 1), TILE_VIEW_COUNT_MAX_SCALE);
  return Math.max(TILE_VIEW_COUNT_HEIGHT, Math.ceil(TILE_VIEW_COUNT_LINE_HEIGHT * scale) + 8);
}

/**
 * What a tile's writing leaves clear at its foot for the views' chip at the
 * reader's text size: the inset, the chip and a gap (review of #929: a fixed
 * clearance let a chip grown with large text cover the last line).
 */
export function tileViewCountClearance(fontScale: number): number {
  return TILE_VIEW_COUNT_INSET + tileViewCountChipHeight(fontScale) + 8;
}

/**
 * On a grid tile, over its picture or plate, bottom left: the tile's badge
 * style, a dark glass chip that reads over any picture and over a text plate
 * in either scheme. Hidden from screen readers, because the tile is one
 * button whose label carries the spoken figure.
 */
export function PostViewCountChip({ labels }: { labels: ViewCountLabels | null | undefined }) {
  const { fontScale } = useWindowDimensions();
  if (!labels) return null;
  return (
    <View
      testID="post-view-count-chip"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        minHeight: tileViewCountChipHeight(fontScale),
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        borderRadius: appTheme.radii.pill,
        paddingHorizontal: 6,
        backgroundColor: mediaColors.mediaChip,
        borderWidth: 1,
        borderColor: hexWithAlpha(mediaColors.onMedia, 0.24),
      }}
    >
      <Eye size={appTheme.icon.xs} color={mediaColors.onMedia} />
      <Text
        maxFontSizeMultiplier={TILE_VIEW_COUNT_MAX_SCALE}
        style={{ color: mediaColors.onMedia, fontSize: 11, lineHeight: TILE_VIEW_COUNT_LINE_HEIGHT, fontWeight: '800', fontVariant: ['tabular-nums'] }}
      >
        {labels.compact}
      </Text>
    </View>
  );
}

/** A tile's button label with its views said in words: "Post, Launch frame, Public, 1,234 views". */
export function withSpokenViewCount(label: string, labels: ViewCountLabels | null | undefined): string {
  return labels ? `${label}, ${labels.spoken}` : label;
}
