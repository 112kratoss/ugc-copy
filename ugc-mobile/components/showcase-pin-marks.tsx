import { Play } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors } from '@/lib/theme';

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
