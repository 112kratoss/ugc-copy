import { Image } from 'expo-image';
import type { ReactElement } from 'react';
import { reelIconAssets } from '@/lib/reel-icon-assets';
import { appTheme } from '@/lib/theme';

/** Only exact, static rail variants use the bundled raster. Unrecognized props
 * keep their original SVG, including custom styles, refs and accessibility. */
export function renderReelIcon(icon: ReactElement, shadow: boolean): ReactElement | null {
  const props = icon.props as Record<string, unknown>;
  if (Object.keys(props).some((key) => !['size', 'color', 'fill', 'strokeWidth'].includes(key))) return null;
  const name = (icon.type as { displayName?: string }).displayName;
  const size = props.size;
  const fill = !props.fill || props.fill === 'transparent' ? 'none' : props.fill;
  const key = [name, size, props.color, fill, props.strokeWidth ?? appTheme.icon.stroke, shadow].join('|');
  const source = reelIconAssets[key];
  if (!source || typeof size !== 'number') return null;
  return <Image source={source} accessible={false} pointerEvents="none"
    contentFit="contain" transition={0} cachePolicy="memory"
    style={{ width: size + 6, height: size + 6, margin: -3 }} />;
}
