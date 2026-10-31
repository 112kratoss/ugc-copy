import { Play } from 'lucide-react-native';
import { View } from 'react-native';

import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The mark a card draws for a clip, centred on its media: on the clip's still
 * or poster, the dark layer the app draws over pictures; on the card's own
 * panel, a disc in the video accent. One size for every card row that shows
 * clips (a recipe's references, a creation's references and its outputs).
 */
export function VideoPlayMark({ onPicture }: { onPicture: boolean }) {
  const theme = useAppTheme();
  const glyph = onPicture ? mediaColors.onMedia : theme.colors.video;
  return (
    <View pointerEvents="none" style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
      backgroundColor: onPicture ? mediaColors.mediaScrimStrong : `${theme.colors.video}1f`,
      borderWidth: onPicture ? 0 : 1, borderColor: `${theme.colors.video}66` }}>
      <Play size={appTheme.icon.default} color={glyph} fill={glyph} />
    </View>
  );
}
