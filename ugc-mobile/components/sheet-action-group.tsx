import { Children, Fragment, type ComponentType } from 'react';
import { Pressable, Text, View } from 'react-native';

import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

type SheetActionIcon = ComponentType<{ color?: string; size?: number }>;

// The icon well and the gap after it: dividers begin where the text does, as
// they do in an iOS grouped list, instead of cutting through the icon column.
const ACTION_ICON_WELL = 40;
const ACTION_ICON_GAP = 14;

export function SheetActionGroup({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}) {
  const theme = useAppTheme();
  const rows = Children.toArray(children);

  return (
    <View
      testID={testID}
      style={{
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.panelSoft,
        overflow: 'hidden',
      }}
    >
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <View
              style={{
                height: 1,
                marginLeft: appTheme.spacing.card + ACTION_ICON_WELL + ACTION_ICON_GAP,
                backgroundColor: theme.colors.border,
              }}
            />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export function SheetActionRow({
  body,
  disabled = false,
  icon: Icon,
  label,
  onPress,
  tone = 'default',
}: {
  body: string;
  disabled?: boolean;
  icon: SheetActionIcon;
  label: string;
  onPress: () => void;
  tone?: 'default' | 'danger';
}) {
  const theme = useAppTheme();
  const danger = tone === 'danger';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={body}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: ACTION_ICON_GAP,
        paddingHorizontal: appTheme.spacing.card,
        paddingVertical: appTheme.spacing.gap,
        backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
        opacity: disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      <View
        style={{
          width: ACTION_ICON_WELL,
          height: ACTION_ICON_WELL,
          borderRadius: ACTION_ICON_WELL / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: danger ? theme.semantic.danger.background : theme.colors.surfaceStrong,
        }}
      >
        <Icon size={appTheme.icon.default} color={danger ? theme.colors.danger : theme.colors.textSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: danger ? theme.colors.danger : theme.colors.text, ...appTheme.type.body, fontWeight: '700' }}>
          {label}
        </Text>
        <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>
          {body}
        </Text>
      </View>
    </Pressable>
  );
}
