import { ImageIcon, Play } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { FeedMediaPlate } from '@/components/feed-media-plate';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

// The marks a feed pin wears over its picture: Explore's masonry and the
// search's posts draw the same ones (search UX audit 2026-11-13, finding 3).
// They sit on dark glass over a picture, so they take media colours in both
// schemes.

export function PinBadge({ label, accent }: { label: string; accent: string }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 10,
        top: 10,
        maxWidth: '82%',
        borderRadius: appTheme.radii.pill,
        backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.78),
        paddingHorizontal: 9,
        // The caption ramp's own line box is 17pt; the padding is what keeps the
        // pill the height it has always been rather than an override on the type.
        paddingVertical: 3,
      }}
    >
      <Text numberOfLines={1} style={{ color: accent, ...appTheme.type.caption, fontWeight: '800' }}>
        {label}
      </Text>
    </View>
  );
}

export function VideoCornerPlay() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        width: 31,
        height: 31,
        borderRadius: appTheme.radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: hexWithAlpha(mediaColors.mediaGround, 0.42),
      }}
    >
      <Play size={16} color={mediaColors.onMedia} fill={mediaColors.onMedia} />
    </View>
  );
}

// A pin whose media has no picture to show yet: a video's plate (a play glyph
// on its accent wash) or a still's. Explore's masonry and the search's posts
// draw the same ones; these follow the theme, as the pin's frame does.
export function VisualFallbackPreview({ accent, height, radius }: { accent: string; height: number; radius: number }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        height,
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.surfaceInset,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <FeedMediaPlate accent={accent} glyph={ImageIcon} />
    </View>
  );
}

export function VideoPinPreview({ accent, height, radius }: { accent: string; height: number; radius: number }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${accent}4d`,
        backgroundColor: theme.colors.mediaPlaceholder,
        overflow: 'hidden',
      }}
    >
      <View style={{ position: 'absolute', inset: 0, backgroundColor: `${accent}12` }} />
      <FeedMediaPlate accent={accent} glyph={Play} filled />
    </View>
  );
}
