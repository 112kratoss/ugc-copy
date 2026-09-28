import { MoreVertical } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { NativeMenuTrigger } from '@/components/native-menu';
import { CreatorAvatar } from '@/components/ui';
import { haptic } from '@/lib/haptics';
import { FEED_CARD_MEDIA_INSET } from '@/lib/feed-card-geometry';
import { MotionView, usePressMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/** The creator byline reads as a single line of text; its reach is widened rather than its height. */
const CREATOR_ROW_HEIGHT = 32;

/**
 * How long a finger must rest on the card before it presses down. A feed is
 * mostly scrolled, and a swipe that starts on the media would otherwise spring
 * the whole card down and back at the start of every scroll. Native lists wait
 * the same way: Android holds the pressed state inside a scrolling container for
 * its 100ms tap timeout, and UIScrollView delays content touches until it can
 * tell a scroll from a tap. A quicker tap still presses and opens.
 */
const CARD_PRESS_DELAY_MS = 100;
import { verticalHitSlop } from '@/lib/hit-target';

/**
 * The card chrome shared by the Home feed and the Profile media feed: a thin
 * attribution line, title and body, rounded media, and quiet actions. Posts
 * sit on the page itself and are separated by a hairline, without an outer
 * card or clipping layer. A text post uses the same reading order.
 *
 * Both surfaces compose this rather than owning their own copy — the Profile
 * tabs previously rendered a separately-authored card that drifted into a
 * different visual language, which is exactly what this prevents.
 */
export function FeedCardShell({
  actions,
  banner,
  body,
  categoryLabel,
  creatorAvatar,
  creatorLabel,
  creatorName,
  onCreatorPress,
  onMorePress,
  moreAccessibilityLabel,
  renderMoreMenu,
  media,
  onOpen,
  onOpenTouchStart,
  nativeZoom = false,
  openAccessibilityLabel,
  statusChip,
  timeLabel,
  title,
}: {
  actions: ReactNode;
  banner?: ReactNode;
  body?: ReactNode;
  categoryLabel: string;
  creatorAvatar: string | null;
  creatorLabel: string;
  creatorName: string;
  onCreatorPress?: () => void;
  onMorePress: () => void;
  moreAccessibilityLabel: string;
  /**
   * Wraps the ⋮ in a native menu (`lib/native-menu.ts`): given the shell's own
   * button, as a function of its press handler, and the iOS trigger drawn to
   * match it, returns what to draw. The menu then runs `onMorePress` only where
   * native menus are missing. Without it, the ⋮ runs `onMorePress`.
   */
  renderMoreMenu?: (more: { trigger: NativeMenuTrigger; renderButton: (onPress: () => void) => ReactNode }) => ReactNode;
  media?: ReactNode;
  onOpen?: () => void;
  /**
   * The finger has gone down on the media: a chance to get its opening ready.
   * Raw touch start, not press-in — the press delay below holds press-in back
   * until most taps have already been released.
   */
  onOpenTouchStart?: () => void;
  /** Keep the measured source still while UIKit takes over its opening. */
  nativeZoom?: boolean;
  openAccessibilityLabel: string;
  /** Publish/visibility state for owned media. Home passes nothing. */
  statusChip?: ReactNode;
  timeLabel: string;
  title: string;
}) {
  const theme = useAppTheme();
  const moreButton = (onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={moreAccessibilityLabel}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => ({ width: 28, height: 32, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <MoreVertical size={appTheme.icon.compact} color={theme.colors.faint} />
    </Pressable>
  );

  // The whole card presses down, not just the tapped region: the header and
  // action rows are separate targets, but the object under the thumb is the
  // card, and that is what should move. Native zoom needs that source to stay
  // at its measured size; UIKit supplies the motion for those media opens.
  const openMotion = usePressMotion(!onOpen || nativeZoom, { scale: appTheme.motion.scale.pressedCard });
  const open = onOpen ? () => {
    haptic.light();
    onOpen();
  } : undefined;
  const caption = (
    <View
      style={{
        paddingTop: appTheme.spacing.compact,
        paddingBottom: appTheme.spacing.gap,
        gap: appTheme.spacing.compact,
      }}
    >
      <Text
        numberOfLines={media ? 2 : 3}
        style={{ color: theme.colors.text, ...appTheme.type.body, fontWeight: '700' }}
      >
        {title}
      </Text>
      {body}
    </View>
  );

  return (
    <MotionView
      style={[
        {
          paddingHorizontal: FEED_CARD_MEDIA_INSET,
          paddingBottom: appTheme.spacing.gap,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          // Only media has rounded corners; the scrolling post has no clip or shadow.
        },
        openMotion.animatedStyle,
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.compact,
          paddingTop: appTheme.spacing.gap,
        }}
      >
        <Pressable
          accessibilityRole={onCreatorPress ? 'button' : undefined}
          accessibilityLabel={onCreatorPress ? `Open ${creatorLabel}` : undefined}
          disabled={!onCreatorPress}
          onPress={onCreatorPress}
          hitSlop={verticalHitSlop(CREATOR_ROW_HEIGHT)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            flex: 1,
            minHeight: CREATOR_ROW_HEIGHT,
            opacity: pressed && onCreatorPress ? appTheme.opacity.pressed : 1,
          })}
        >
          <CreatorAvatar uri={creatorAvatar} name={creatorName} size={22} />
          <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
            {creatorLabel}
          </Text>
          <Text style={{ color: theme.colors.faint, ...appTheme.type.caption }}>
            {`· ${timeLabel}`}
          </Text>
        </Pressable>
        {statusChip}
        <View>
          <Text style={{ color: theme.colors.faint, ...appTheme.type.caption }}>
            {categoryLabel}
          </Text>
        </View>
        {renderMoreMenu ? renderMoreMenu({
          trigger: {
            width: 28,
            height: 32,
            iconSize: appTheme.icon.compact,
            iconColor: theme.colors.faint,
            vertical: true,
            alignment: 'trailing',
            hitSlop: 10,
          },
          renderButton: moreButton,
        }) : moreButton(onMorePress)}
      </View>

      {media ? (
        <Pressable accessible={false} disabled={!onOpen} onPress={open}>
          {caption}
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openAccessibilityLabel}
        disabled={!onOpen}
        onPress={open}
        onPressIn={openMotion.onPressIn}
        onPressOut={openMotion.onPressOut}
        onTouchStart={onOpenTouchStart}
        unstable_pressDelay={CARD_PRESS_DELAY_MS}
      >
        {media ?? caption}
      </Pressable>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 6,
          paddingTop: appTheme.spacing.compact,
        }}
      >
        {actions}
      </View>

      {banner}
    </MotionView>
  );
}

export function FeedCardAction({
  accessibilityLabel,
  disabled,
  icon,
  label,
  loading,
  onPress,
  tone,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: ReactNode;
  label?: string;
  /** Swaps the glyph for a spinner and blocks repeat taps while a request is in flight. */
  loading?: boolean;
  onPress: () => void;
  tone?: 'default' | 'primary' | 'success' | 'warning';
}) {
  const theme = useAppTheme();
  const labelColor = tone === 'primary'
    ? theme.colors.primary
    : tone === 'success'
      ? theme.colors.success
      : tone === 'warning'
        ? theme.colors.warning
        : theme.colors.faint;
  const motion = usePressMotion(Boolean(disabled || loading), { scale: appTheme.motion.scale.pressedControl });

  return (
    <MotionView style={motion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
        disabled={disabled || loading}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          minHeight: 44,
          minWidth: label ? 56 : 44,
          borderRadius: appTheme.radii.pill,
          borderWidth: 1,
          borderColor: theme.colors.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingHorizontal: appTheme.spacing.compact,
          opacity: disabled || loading ? appTheme.opacity.pressed : 1,
        }}
      >
        {loading ? <ActivityIndicator color={labelColor} size="small" /> : icon}
        {label ? (
          <Text style={{ color: labelColor, ...appTheme.type.caption, fontWeight: '800' }}>
            {label}
          </Text>
        ) : null}
      </Pressable>
    </MotionView>
  );
}
