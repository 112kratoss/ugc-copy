import { Image } from 'expo-image';
import type { ComponentType } from 'react';
import { View } from 'react-native';

import type { SearchThumbnail } from '@/lib/public-search-policy/public-search-policy';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The picture a search row carries (2026-11-15: `thumbnail`, a post made with
 * a model or tool, or one a search finds; a video's is its poster), in the
 * frame the row's glyph is drawn in without one, so a row with a picture and
 * one without stand in line. A thing is a rounded square, as a person's avatar
 * is a circle beside it; a `circle` sits at the start of a capsule chip.
 *
 * The glyph is drawn whether or not there is a picture, and the picture covers
 * it once it arrives (its thumbhash at once where the answer gives one), as an
 * avatar's initial is: a picture that never loads leaves the glyph, never an
 * empty frame. The picture is decoration: the row's name says what it is.
 */
export function SearchRowPicture({
  thumbnail,
  size,
  shape = 'square',
  Icon,
  iconSize = appTheme.icon.sm,
  iconTone = 'accent',
  testID,
}: {
  thumbnail: SearchThumbnail | null | undefined;
  size: number;
  shape?: 'square' | 'circle';
  /** The row's glyph (a Lucide icon the caller imports, one module per icon: bundle-shaping.test.ts). */
  Icon: ComponentType<{ size?: number; color?: string }>;
  iconSize?: number;
  /**
   * The glyph's colour: the accent for a model's or tool's row, muted for a
   * search to try, as a related search's chip and a recent search draw theirs.
   */
  iconTone?: 'accent' | 'muted';
  testID?: string;
}) {
  const theme = useAppTheme();
  const frame = shape === 'circle'
    ? { width: size, height: size, borderRadius: size / 2 }
    : { width: size, height: size, borderRadius: appTheme.radii.xs, borderCurve: 'continuous' as const };
  return (
    <View
      testID={testID}
      style={{
        ...frame,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceStrong,
      }}
    >
      <Icon size={iconSize} color={iconTone === 'muted' ? theme.colors.muted : theme.colors.primary} />
      {thumbnail ? (
        <Image
          source={{ uri: thumbnail.url }}
          placeholder={thumbnail.thumbhash ? { thumbhash: thumbnail.thumbhash } : undefined}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={thumbnail.postId}
          accessible={false}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : null}
    </View>
  );
}
