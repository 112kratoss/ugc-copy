import { SmilePlus } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppText } from '@/components/ui';
import { showActionSheet } from '@/lib/action-sheet';
import { haptic } from '@/lib/haptics';
import { MIN_HIT_TARGET_PT, verticalHitSlop } from '@/lib/hit-target';
import {
  SUPPORT_HUB_REACTION_EMOJIS,
  SUPPORT_HUB_WORDS,
  type SupportHubReactionEmoji,
} from '@/lib/support-hub-policy/support-hub-policy';
import {
  supportHubReactionChipsOf,
  supportHubReactionSheetTitle,
  type SupportHubReactionState,
} from '@/lib/support-hub-view-model';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** A reaction chip is drawn this tall, and answers to 44pt through its slop, as one-line controls do. */
const REACTION_CHIP_HEIGHT = 32;
/** The emoji in a chip, at the size the chat's reaction pills draw it. */
const REACTION_EMOJI_FONT = { fontSize: 15, lineHeight: 20 } as const;

/**
 * The reactions under an update or a roadmap item: a chip for each quick
 * reaction someone chose, with its count (the reader's own drawn selected),
 * and a button that offers all six. A press sets, changes or takes away the
 * reader's one reaction; a guest's press asks them to sign up instead
 * (`onSignIn`). `trailing` sits at the row's end (the update's comments).
 */
export function SupportHubReactions({
  subject,
  state,
  canReact,
  onReact,
  onSignIn,
  failed = false,
  trailing,
}: {
  /** What is being reacted to (the title), for the picker's heading. */
  subject: string;
  state: SupportHubReactionState;
  canReact: boolean;
  onReact: (emoji: SupportHubReactionEmoji) => void;
  onSignIn: () => void;
  /** The last reaction to this item was not saved. */
  failed?: boolean;
  trailing?: ReactNode;
}) {
  const theme = useAppTheme();
  const chips = supportHubReactionChipsOf(state, canReact);

  const pressChip = (emoji: SupportHubReactionEmoji) => {
    if (!canReact) {
      onSignIn();
      return;
    }
    haptic.select();
    onReact(emoji);
  };

  const openPicker = () => {
    if (!canReact) {
      onSignIn();
      return;
    }
    // The sheet's row of six ticks a choice itself.
    showActionSheet({
      title: supportHubReactionSheetTitle(subject),
      actions: [],
      reactions: {
        label: SUPPORT_HUB_WORDS.react,
        options: SUPPORT_HUB_REACTION_EMOJIS,
        selected: state.myReaction,
        onSelect: (option) => onReact(option as SupportHubReactionEmoji),
      },
    });
  };

  return (
    <View style={{ gap: appTheme.spacing.unit }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: appTheme.spacing.compact }}>
        {chips.map((chip) => (
          <Pressable
            key={chip.emoji}
            accessibilityRole="button"
            accessibilityLabel={chip.label}
            accessibilityHint={chip.hint}
            accessibilityState={{ selected: chip.mine }}
            onPress={() => pressChip(chip.emoji)}
            hitSlop={verticalHitSlop(REACTION_CHIP_HEIGHT)}
            style={({ pressed }) => ({
              minHeight: REACTION_CHIP_HEIGHT,
              minWidth: MIN_HIT_TARGET_PT,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: appTheme.spacing.unit,
              paddingHorizontal: appTheme.spacing.compact,
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: chip.mine ? theme.colors.primary : theme.colors.border,
              backgroundColor: chip.mine ? theme.colors.selected : pressed ? theme.colors.pressed : theme.colors.surface,
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Text style={REACTION_EMOJI_FONT}>{chip.emoji}</Text>
            <AppText
              variant="label"
              color={chip.mine ? 'primary' : 'textSecondary'}
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {chip.count.toLocaleString('en-US')}
            </AppText>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={canReact ? SUPPORT_HUB_WORDS.react : SUPPORT_HUB_WORDS.signInToReact}
          accessibilityHint={canReact ? 'Shows the six quick reactions' : undefined}
          onPress={openPicker}
          hitSlop={verticalHitSlop(REACTION_CHIP_HEIGHT)}
          style={({ pressed }) => ({
            minHeight: REACTION_CHIP_HEIGHT,
            minWidth: MIN_HIT_TARGET_PT,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: appTheme.spacing.unit,
            paddingHorizontal: appTheme.spacing.compact,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: pressed ? theme.colors.pressed : 'transparent',
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <SmilePlus size={appTheme.icon.sm} color={theme.colors.muted} />
          {/* Words beside the glyph while nobody has reacted, so an empty row still says what it is for. */}
          {chips.length === 0 ? (
            <AppText variant="label" color="muted">{SUPPORT_HUB_WORDS.react}</AppText>
          ) : null}
        </Pressable>
        {trailing ? <View style={{ marginLeft: 'auto' }}>{trailing}</View> : null}
      </View>
      {failed ? (
        <AppText variant="caption" color="danger" accessibilityLiveRegion="polite">
          {SUPPORT_HUB_WORDS.reactionFailed}
        </AppText>
      ) : null}
    </View>
  );
}
