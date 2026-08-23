import { MoreVertical } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

/**
 * The card chrome shared by the Home feed and the Profile media feed: a thin
 * attribution line, then the media as the loudest thing on the card, the
 * action row, and the title and body as a caption beneath — the prompt is
 * context for the picture, not a headline above it. A post with no media
 * keeps its title up front, because there the words are the content.
 *
 * Both surfaces compose this rather than owning their own copy — the Profile
 * tabs previously rendered a separately-authored card that drifted into a
 * different visual language, which is exactly what this prevents.
 */
export function FeedCardShell({
  accent,
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
  media,
  onOpen,
  openAccessibilityLabel,
  statusChip,
  timeLabel,
  title,
}: {
  accent: string;
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
  media?: ReactNode;
  onOpen?: () => void;
  openAccessibilityLabel: string;
  /** Publish/visibility state for owned media. Home passes nothing. */
  statusChip?: ReactNode;
  timeLabel: string;
  title: string;
}) {
  // The whole card presses down, not just the tapped region: the header and
  // action rows are separate targets, but the object under the thumb is the
  // card, and that is what should move.
  const openMotion = usePressMotion(!onOpen, { scale: appTheme.motion.scale.pressedCard });
  const open = onOpen ? () => {
    haptic.light();
    onOpen();
  } : undefined;
  const caption = (
    <View
      style={{
        paddingHorizontal: appTheme.spacing.card,
        paddingTop: media ? 0 : appTheme.spacing.compact,
        paddingBottom: body || media ? appTheme.spacing.gap : appTheme.spacing.compact,
        gap: appTheme.spacing.compact,
      }}
    >
      <Text
        numberOfLines={media ? 2 : 3}
        style={media
          ? { color: appTheme.colors.text, ...appTheme.type.bodySm, fontWeight: '600' }
          : { color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontSize: 19, lineHeight: 25 }}
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
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: appTheme.colors.borderSubtle,
          backgroundColor: appTheme.colors.panel,
          overflow: 'hidden',
        },
        openMotion.animatedStyle,
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.compact,
          paddingHorizontal: appTheme.spacing.card,
          paddingTop: appTheme.spacing.gap,
        }}
      >
        <Pressable
          accessibilityRole={onCreatorPress ? 'button' : undefined}
          accessibilityLabel={onCreatorPress ? `Open ${creatorLabel}` : undefined}
          disabled={!onCreatorPress}
          onPress={onCreatorPress}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            flex: 1,
            minHeight: 32,
            opacity: pressed && onCreatorPress ? appTheme.opacity.pressed : 1,
          })}
        >
          <CreatorAvatar uri={creatorAvatar} name={creatorName} size={22} />
          <Text numberOfLines={1} style={{ color: appTheme.colors.textSecondary, ...appTheme.type.caption, fontWeight: '800', flexShrink: 1 }}>
            {creatorLabel}
          </Text>
          <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>
            {`· ${timeLabel}`}
          </Text>
        </Pressable>
        {statusChip}
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: `${accent}44`,
            backgroundColor: `${accent}1a`,
          }}
        >
          <Text style={{ color: accent, ...appTheme.type.caption, fontSize: 11, fontWeight: '800' }}>
            {categoryLabel}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moreAccessibilityLabel}
          hitSlop={10}
          onPress={onMorePress}
          style={{ width: 28, height: 32, alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <MoreVertical size={17} color={appTheme.colors.faint} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openAccessibilityLabel}
        disabled={!onOpen}
        onPress={open}
        onPressIn={openMotion.onPressIn}
        onPressOut={openMotion.onPressOut}
        style={{ paddingTop: media ? appTheme.spacing.gap : 0 }}
      >
        {media ? media : caption}
      </Pressable>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingHorizontal: appTheme.spacing.compact,
          paddingVertical: media ? 2 : appTheme.spacing.compact,
        }}
      >
        {actions}
      </View>

      {media ? (
        <Pressable accessible={false} disabled={!onOpen} onPress={open}>
          {caption}
        </Pressable>
      ) : null}

      {banner ? <View style={{ paddingBottom: appTheme.spacing.gap }}>{banner}</View> : null}
    </MotionView>
  );
}

export function FeedCardAction({
  accessibilityLabel,
  disabled,
  icon,
  label,
  onPress,
  tone,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: ReactNode;
  label?: string;
  onPress: () => void;
  tone?: 'default' | 'primary' | 'success' | 'warning';
}) {
  const labelColor = tone === 'primary'
    ? appTheme.colors.primary
    : tone === 'success'
      ? appTheme.colors.success
      : tone === 'warning'
        ? appTheme.colors.warning
        : appTheme.colors.faint;
  const motion = usePressMotion(Boolean(disabled), { scale: appTheme.motion.scale.pressedControl });

  return (
    <MotionView style={motion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          minHeight: 44,
          minWidth: 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingHorizontal: appTheme.spacing.compact,
          opacity: disabled ? appTheme.opacity.pressed : 1,
        }}
      >
        {icon}
        {label ? (
          <Text style={{ color: labelColor, ...appTheme.type.caption, fontWeight: '800' }}>
            {label}
          </Text>
        ) : null}
      </Pressable>
    </MotionView>
  );
}
