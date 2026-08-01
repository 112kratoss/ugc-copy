import { MoreVertical } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CreatorAvatar } from '@/components/ui';
import { appTheme } from '@/lib/theme';

/**
 * The card chrome shared by the Home feed and the Profile media feed: a thin
 * attribution line, the title as the loudest thing on the card, then media,
 * an optional banner, and an action row.
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
  return (
    <View
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        overflow: 'hidden',
      }}
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
        onPress={onOpen}
        style={({ pressed }) => ({ opacity: pressed && onOpen ? appTheme.opacity.pressed : 1 })}
      >
        <View
          style={{
            paddingHorizontal: appTheme.spacing.card,
            paddingTop: appTheme.spacing.compact,
            paddingBottom: body || media ? appTheme.spacing.gap : appTheme.spacing.compact,
            gap: appTheme.spacing.compact,
          }}
        >
          <Text numberOfLines={3} style={{ color: appTheme.colors.text, ...appTheme.type.sectionTitle, fontSize: 19, lineHeight: 25 }}>
            {title}
          </Text>
          {body}
        </View>
        {media}
      </Pressable>

      {banner}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingHorizontal: appTheme.spacing.compact,
          paddingVertical: appTheme.spacing.compact,
        }}
      >
        {actions}
      </View>
    </View>
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: appTheme.spacing.compact,
        opacity: pressed || disabled ? appTheme.opacity.pressed : 1,
      })}
    >
      {icon}
      {label ? (
        <Text style={{ color: labelColor, ...appTheme.type.caption, fontWeight: '800' }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
