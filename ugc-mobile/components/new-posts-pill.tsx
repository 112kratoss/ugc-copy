import { ArrowUp } from 'lucide-react-native';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { verticalHitSlop } from '@/lib/hit-target';
import { MotionView, useOverlayPresence, usePressMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

const PILL_HEIGHT = 40;

/**
 * "New posts", floating over the top of a ranked feed when the server has a
 * post newer than any the lane holds (`lib/use-new-posts-probe.ts`). The feed
 * is never swapped under the reader on a return to the app; this offers the
 * refresh instead, and the screen's tap handler is its own refresh (product
 * decision D2, 2026-10-14). It fades in and out, at once under Reduce Motion.
 *
 * The screen places it under its header with `topOffset`; the row it sits in
 * passes every touch outside the pill through to the list.
 */
export function NewPostsPill({
  onPress,
  topOffset = 0,
  visible,
}: {
  onPress: () => void;
  /** From the top of the screen to the pill: below the screen's header. */
  topOffset?: number;
  visible: boolean;
}) {
  const theme = useAppTheme();
  const presence = useOverlayPresence(visible);
  const motion = usePressMotion(!visible);

  if (!presence.mounted) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: topOffset, left: 0, right: 0, alignItems: 'center', zIndex: 2 }}
    >
      <MotionView
        pointerEvents={visible ? 'auto' : 'none'}
        style={presence.animatedStyle as StyleProp<ViewStyle>}
      >
        <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New posts"
            accessibilityHint="Goes to the top of the feed and shows them"
            accessibilityLiveRegion="polite"
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            disabled={!visible}
            hitSlop={verticalHitSlop(PILL_HEIGHT)}
            onPress={onPress}
            onPressIn={motion.onPressIn}
            onPressOut={motion.onPressOut}
            style={({ pressed }) => ({
              minHeight: PILL_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: appTheme.spacing.compact,
              paddingHorizontal: appTheme.spacing.card,
              borderRadius: appTheme.radii.pill,
              borderCurve: 'continuous',
              backgroundColor: pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
              boxShadow: theme.shadow.soft.boxShadow,
            })}
          >
            <ArrowUp color={theme.colors.onPrimary} size={appTheme.icon.sm} />
            <AppText selectable={false} variant="label" color="onPrimary" numberOfLines={1}>
              New posts
            </AppText>
          </Pressable>
        </MotionView>
      </MotionView>
    </View>
  );
}
