import { Repeat2 } from 'lucide-react-native';
import { Pressable, Text, View, type TextStyle } from 'react-native';

import { verticalHitSlop } from '@/lib/hit-target';
import {
  REMIX_CREDIT_CARD_TITLE_MAX_LENGTH,
  remixCreditLabel,
  remixCreditSegments,
  type RemixCredit,
} from '@/lib/remix-credit/remix-credit';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** The line's own height at the caption size; its hit region is raised to 44pt around it. */
const ROW_HEIGHT = appTheme.type.caption.lineHeight;

/**
 * A remix post's credit (owner, 2026-11-05), in the web's words
 * (`lib/remix-credit`): "Remix of “title” by @A", and "· Original by @A" when
 * the chain began with someone else. One target for a thumb: it opens the post
 * remixed, or, when that post can no longer be shown, the original's creator.
 * Nothing for a post that is no remix.
 */
export function RemixCreditLine({
  remixCredit: credit,
  onOpenPost,
  onOpenCreator,
  tone = 'surface',
  numberOfLines = 1,
  textStyle,
}: {
  remixCredit: RemixCredit | null | undefined;
  onOpenPost: (postId: string) => void;
  onOpenCreator: (username: string) => void;
  /** `media` over a picture (the reel), in the light words drawn over pictures. */
  tone?: 'surface' | 'media';
  numberOfLines?: number;
  /** The reel's text shadow, which a line over a picture needs. */
  textStyle?: TextStyle;
}) {
  const theme = useAppTheme();
  if (!credit) return null;
  // Held to its lines (the cards, the reel, Details), a long title is shortened so "Original by" keeps
  // its room; what VoiceOver reads keeps the whole line.
  const segments = remixCreditSegments(credit, numberOfLines ? { titleMaxLength: REMIX_CREDIT_CARD_TITLE_MAX_LENGTH } : {});
  const parent = credit.parent;
  const original = credit.original;
  const open = parent
    ? () => onOpenPost(parent.postId)
    : original
      ? () => onOpenCreator(original.username)
      : undefined;
  const muted = tone === 'media' ? mediaColors.onMediaSecondary : theme.colors.muted;
  const strong = tone === 'media' ? mediaColors.onMedia : theme.colors.text;

  return (
    <Pressable
      testID="remix-credit"
      accessibilityRole="link"
      accessibilityLabel={remixCreditLabel(credit)}
      accessibilityHint={parent ? 'Opens the post it remixed' : 'Opens their profile'}
      onPress={open}
      hitSlop={verticalHitSlop(ROW_HEIGHT)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        minHeight: ROW_HEIGHT,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      {/* Centred on the first line, so a credit that wraps keeps its icon beside "Remix of". */}
      <View style={{ height: ROW_HEIGHT, justifyContent: 'center' }}>
        <Repeat2 size={appTheme.icon.xs} color={muted} />
      </View>
      <Text numberOfLines={numberOfLines} style={[{ flexShrink: 1, color: muted, ...appTheme.type.caption }, textStyle]}>
        {segments.map((segment, index) => (
          <Text key={index} style={segment.kind === 'text' ? undefined : { color: strong, fontWeight: '700' }}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  );
}
