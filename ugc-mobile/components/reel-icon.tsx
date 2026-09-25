import type { ReactElement } from 'react';
import { Image } from 'react-native';
import { reelIconAssets } from '@/lib/reel-icon-assets';
import { appTheme } from '@/lib/theme';

/** Only exact, static rail variants use the bundled raster. Unrecognized props
 * keep their original SVG, including custom styles, refs and accessibility.
 *
 * Drawn with React Native's Image: a bundled PNG needs none of expo-image's
 * caching or crossfade, and on Android an expo-image is four native views (a
 * wrapper, a frame and two image views kept for the crossfade) where Image is
 * one. Every slide builds its rail's icons as it mounts, mid-swipe for the
 * slide beyond the one being landed on. `fadeDuration` 0: Android fades an
 * Image in over 300 ms by default. */
export function renderReelIcon(icon: ReactElement, shadow: boolean): ReactElement | null {
  const props = icon.props as Record<string, unknown>;
  if (Object.keys(props).some((key) => !['size', 'color', 'fill', 'strokeWidth'].includes(key))) return null;
  const name = (icon.type as { displayName?: string }).displayName;
  const size = props.size;
  const fill = !props.fill || props.fill === 'transparent' ? 'none' : props.fill;
  const key = [name, size, props.color, fill, props.strokeWidth ?? appTheme.icon.stroke, shadow].join('|');
  const source = reelIconAssets[key];
  if (!source || typeof size !== 'number') return null;
  return <Image source={source} accessible={false} fadeDuration={0} resizeMode="contain"
    style={{ width: size + 6, height: size + 6, margin: -3 }} />;
}
