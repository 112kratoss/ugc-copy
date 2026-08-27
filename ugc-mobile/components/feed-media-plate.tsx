import type { ComponentType } from 'react';
import { View } from 'react-native';

import { appTheme } from '@/lib/theme';

type FeedMediaPlateGlyph = ComponentType<{ size?: number; color?: string; fill?: string }>;

/**
 * The circle a feed tile shows when it has no picture to show: a preview still
 * being generated, a video the feed is not allowed to stream, a post whose
 * media never resolved.
 *
 * One component because there were four of these — the showcase grid's video
 * and image fallbacks, the media preview's pending plate, the video preview's
 * posterless plate — drawn at 46 and 48pt, over three background alphas and two
 * border alphas, with their glyphs at 19, 19, 21 and 22, in white on two of
 * them and the accent on the other two. Icons: "all interface icons in your app
 * need to use a consistent size, level of detail, stroke thickness (or weight),
 * and perspective." Design principles/Familiarity: "Once you establish a
 * behavior or appearance for an element, apply it throughout your design."
 *
 * The glyph arrives as a component rather than an element, so a call site
 * passes neither a size nor a weight — the same reason `LucideProvider` owns
 * the stroke.
 */
export function FeedMediaPlate({
  accent,
  glyph: Glyph,
  filled = false,
}: {
  accent: string;
  glyph: FeedMediaPlateGlyph;
  /** Solid glyphs — the play triangle — read as a shape rather than an outline. */
  filled?: boolean;
}) {
  return (
    <View
      style={{
        width: FEED_MEDIA_PLATE_SIZE,
        height: FEED_MEDIA_PLATE_SIZE,
        borderRadius: FEED_MEDIA_PLATE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: `${accent}66`,
        backgroundColor: `${accent}22`,
      }}
    >
      <Glyph
        size={appTheme.icon.default}
        color={appTheme.colors.text}
        {...(filled ? { fill: appTheme.colors.text } : {})}
      />
    </View>
  );
}

/**
 * White on an accent-tinted circle, not the accent itself: the plate stands in
 * for a picture, and the accent is already carrying the tile's category on the
 * border and fill around it.
 */
export const FEED_MEDIA_PLATE_SIZE = 46;
