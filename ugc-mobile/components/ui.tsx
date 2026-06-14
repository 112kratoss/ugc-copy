import { Link } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme, type ToolAccent, accentColor } from '@/lib/theme';

type TextVariant = keyof typeof appTheme.type;
type ThemeColor = keyof typeof appTheme.colors;
type IconComponent = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
}>;

function textRole(variant: TextVariant): TextStyle {
  return appTheme.type[variant] as TextStyle;
}

function colorValue(color: ThemeColor | string) {
  return color in appTheme.colors ? appTheme.colors[color as ThemeColor] : color;
}

export function Screen({
  children,
  scroll = true,
  insideTab = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  insideTab?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topPadding = appTheme.spacing.screen + (insideTab ? resolvedTopInset(insets.top) : 0);
  const bottomPadding = insideTab
    ? getMagicTabBarMetrics(width, resolvedBottomInset(insets.bottom)).contentBottomPadding
    : 36;

  if (!scroll) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: appTheme.colors.background,
          paddingHorizontal: appTheme.spacing.screen,
          paddingTop: topPadding,
          paddingBottom: bottomPadding,
        }}
      >
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: appTheme.colors.background }}
      contentContainerStyle={{
        paddingHorizontal: appTheme.spacing.screen,
        paddingTop: topPadding,
        gap: appTheme.spacing.section,
        paddingBottom: bottomPadding,
      }}
    >
      {children}
    </ScrollView>
  );
}

export function AppText({
  children,
  variant = 'body',
  color = 'text',
  selectable = true,
  style,
  numberOfLines,
}: {
  children: React.ReactNode;
  variant?: TextVariant;
  color?: ThemeColor | string;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[textRole(variant), { color: colorValue(color) }, style]}
    >
      {children}
    </Text>
  );
}

export function Kicker({
  children,
  color = 'faint',
  style,
}: {
  children: React.ReactNode;
  color?: ThemeColor | string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <AppText
      variant="label"
      color={color}
      style={[{ letterSpacing: 1.2, textTransform: 'uppercase' }, style]}
    >
      {children}
    </AppText>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flex: 1, gap: appTheme.spacing.compact }}>
          {eyebrow ? <Kicker>{eyebrow}</Kicker> : null}
          <AppText variant="pageTitle">{title}</AppText>
        </View>
        {action ? <View style={{ flexShrink: 0 }}>{action}</View> : null}
      </View>
      {body ? (
        <AppText variant="bodySm" color="muted">
          {body}
        </AppText>
      ) : null}
    </View>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  body,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
}) {
  return <SectionHeader eyebrow={eyebrow} title={title} body={body} />;
}

export function Card({
  children,
  accent,
  variant = 'default',
  padding = 'md',
  style,
}: {
  children: React.ReactNode;
  accent?: ToolAccent;
  variant?: 'default' | 'soft' | 'inset';
  padding?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}) {
  const paddingValue = {
    sm: appTheme.spacing.gap,
    md: appTheme.spacing.card,
    lg: appTheme.spacing.panel,
  }[padding];
  const backgroundColor = {
    default: appTheme.colors.panel,
    soft: appTheme.colors.surface,
    inset: appTheme.colors.surfaceInset,
  }[variant];

  return (
    <View
      style={[
        {
          gap: appTheme.spacing.gap,
          borderWidth: 1,
          borderColor: accent ? `${accentColor(accent)}55` : appTheme.colors.borderSubtle,
          backgroundColor,
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          padding: paddingValue,
        },
        variant === 'default' ? (appTheme.shadow.panel as ViewStyle) : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SurfaceSection({
  children,
  eyebrow,
  title,
  body,
  accent,
  action,
  style,
}: {
  children?: React.ReactNode;
  eyebrow?: string;
  title: string;
  body?: string;
  accent?: ToolAccent;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card accent={accent} style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flex: 1, gap: 5 }}>
          {eyebrow ? <Kicker color={accent ? accentColor(accent) : 'faint'}>{eyebrow}</Kicker> : null}
          <AppText variant="cardTitle">{title}</AppText>
          {body ? (
            <AppText variant="bodySm" color="muted">
              {body}
            </AppText>
          ) : null}
        </View>
        {action ? <View style={{ flexShrink: 0 }}>{action}</View> : null}
      </View>
      {children}
    </Card>
  );
}

export function DisclosureSection({
  children,
  expanded,
  onToggle,
  title,
  body,
  accent,
}: {
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  title: string;
  body?: string;
  accent?: ToolAccent;
}) {
  const color = accent ? accentColor(accent) : appTheme.colors.textSecondary;

  return (
    <SurfaceSection
      eyebrow={expanded ? 'Expanded' : 'Collapsed'}
      title={title}
      body={body}
      accent={accent}
      action={(
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.compact,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: `${color}55`,
            borderRadius: appTheme.radii.pill,
            backgroundColor: `${color}1f`,
            opacity: pressed ? appTheme.opacity.pressed : 1,
            paddingHorizontal: appTheme.spacing.gap,
          })}
        >
          <AppText selectable={false} variant="label" color={color}>
            {expanded ? 'Hide' : 'Show'}
          </AppText>
        </Pressable>
      )}
    >
      {expanded ? children : null}
    </SurfaceSection>
  );
}

export function ChoiceChip({
  label,
  active,
  onPress,
  disabled = false,
  accent = 'motion',
  grow = false,
  compact = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  accent?: ToolAccent;
  grow?: boolean;
  compact?: boolean;
}) {
  const color = accentColor(accent);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: grow ? 1 : undefined,
        minHeight: compact ? 34 : appTheme.touch.compact,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: active ? `${color}8a` : appTheme.colors.border,
        backgroundColor: active ? `${color}24` : appTheme.colors.surfaceStrong,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: compact ? appTheme.spacing.gap : appTheme.spacing.card,
      })}
    >
      <AppText
        selectable={false}
        variant={compact ? 'caption' : 'label'}
        color={active ? appTheme.colors.text : appTheme.colors.muted}
        numberOfLines={1}
        style={{ fontWeight: active ? '900' : '800' }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  body,
  accent,
  onPress,
  compact = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  body?: string;
  accent?: ToolAccent;
  onPress?: () => void;
  compact?: boolean;
}) {
  const content = (
    <>
      {icon ? (
        <View
          style={{
            width: compact ? 34 : 42,
            height: compact ? 34 : 42,
            borderRadius: compact ? 17 : 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: accent ? `${accentColor(accent)}1f` : appTheme.colors.surfaceStrong,
          }}
        >
          {icon}
        </View>
      ) : null}
      <View style={{ gap: 4 }}>
        <Kicker>{label}</Kicker>
        <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>
          {value}
        </AppText>
        {body ? (
          <AppText variant="caption" color="muted">
            {body}
          </AppText>
        ) : null}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <Card accent={accent} padding="sm" style={{ flex: 1, minHeight: compact ? 76 : 104 }}>
        {content}
      </Card>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Card accent={accent} padding="sm" style={{ minHeight: compact ? 76 : 104 }}>
        {content}
      </Card>
    </Pressable>
  );
}

export function ReadinessRow({
  label,
  body,
  state = 'neutral',
}: {
  label: string;
  body: string;
  state?: 'neutral' | 'ready' | 'warning' | 'danger';
}) {
  const color = state === 'ready'
    ? appTheme.colors.success
    : state === 'warning'
      ? appTheme.colors.commerce
      : state === 'danger'
        ? appTheme.colors.danger
        : appTheme.colors.muted;

  return (
    <View
      style={{
        minHeight: appTheme.touch.compact,
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.gap,
        borderRadius: appTheme.radii.md,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: `${color}55`,
        backgroundColor: `${color}16`,
        paddingHorizontal: appTheme.spacing.gap,
        paddingVertical: appTheme.spacing.compact,
      }}
    >
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText selectable={false} variant="label" color={color}>
          {label}
        </AppText>
        <AppText variant="caption" color="muted">
          {body}
        </AppText>
      </View>
    </View>
  );
}

export function ToggleRow({
  label,
  body,
  value,
  onValueChange,
  disabled = false,
  accent = 'workflow',
}: {
  label: string;
  body?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accent?: ToolAccent;
}) {
  const color = accentColor(accent);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        minHeight: 58,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: value ? `${color}66` : appTheme.colors.border,
        backgroundColor: value ? `${color}18` : appTheme.colors.surfaceStrong,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: appTheme.spacing.gap,
        opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: appTheme.spacing.card,
        paddingVertical: appTheme.spacing.gap,
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <AppText selectable={false} variant="label" color={value ? color : appTheme.colors.text}>
          {label}
        </AppText>
        {body ? (
          <AppText variant="caption" color="muted">
            {body}
          </AppText>
        ) : null}
      </View>
      <View
        style={{
          width: 46,
          height: 28,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: value ? `${color}88` : appTheme.colors.borderStrong,
          backgroundColor: value ? `${color}33` : appTheme.colors.surfaceInset,
          justifyContent: 'center',
          paddingHorizontal: 3,
        }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: value ? color : appTheme.colors.muted,
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
    </Pressable>
  );
}

export function BottomActionDock({
  children,
  eyebrow = 'Publish dock',
  title,
  body,
  accent = 'motion',
  style,
}: {
  children: React.ReactNode;
  eyebrow?: string;
  title: string;
  body?: string;
  accent?: ToolAccent;
  style?: StyleProp<ViewStyle>;
}) {
  const color = accentColor(accent);

  return (
    <View
      style={[
        {
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: `${color}55`,
          backgroundColor: appTheme.colors.panel,
          padding: appTheme.spacing.card,
          gap: appTheme.spacing.gap,
        },
        appTheme.shadow.panel as ViewStyle,
        style,
      ]}
    >
      <View style={{ gap: 4 }}>
        <Kicker color={color}>{eyebrow}</Kicker>
        <AppText variant="cardTitle">{title}</AppText>
        {body ? (
          <AppText variant="caption" color="muted">
            {body}
          </AppText>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  accent = 'image',
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  accent?: ToolAccent;
}) {
  const fillColor = accentColor(accent);
  const textColor = accent === 'image' || accent === 'amber' || accent === 'commerce'
    ? appTheme.colors.textInverse
    : '#ffffff';

  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.default,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        backgroundColor: disabled ? appTheme.colors.panelSoft : fillColor,
        opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
        paddingHorizontal: appTheme.spacing.panel,
      })}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <AppText selectable={false} variant="button" color={textColor}>{label}</AppText>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appTheme.touch.compact,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panelSoft,
        opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
        paddingHorizontal: appTheme.spacing.card,
      })}
    >
      <AppText selectable={false} variant="label" color="text">{label}</AppText>
    </Pressable>
  );
}

export function AppTextInput({
  label,
  multiline,
  ...props
}: TextInputProps & {
  label: string;
}) {
  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <Kicker color="muted">{label}</Kicker>
      <TextInput
        placeholderTextColor={appTheme.colors.faint}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={{
          minHeight: multiline ? 112 : 48,
          borderWidth: 1,
          borderColor: appTheme.colors.border,
          borderRadius: appTheme.radii.md,
          borderCurve: 'continuous',
          backgroundColor: appTheme.colors.app,
          color: appTheme.colors.text,
          ...textRole('bodySm'),
          paddingHorizontal: appTheme.spacing.gap,
          paddingVertical: appTheme.spacing.gap,
        }}
        {...props}
      />
    </View>
  );
}

export function Pill({
  label,
  accent,
  icon: Icon,
  style,
}: {
  label: string;
  accent?: ToolAccent;
  icon?: IconComponent;
  style?: StyleProp<ViewStyle>;
}) {
  const color = accent ? accentColor(accent) : appTheme.colors.textSecondary;

  return (
    <View
      style={[
        {
          minHeight: 32,
          flexDirection: 'row',
          alignItems: 'center',
          gap: appTheme.spacing.compact,
          alignSelf: 'flex-start',
          borderWidth: 1,
          borderColor: accent ? `${color}55` : appTheme.colors.borderSubtle,
          borderRadius: appTheme.radii.pill,
          backgroundColor: accent ? `${color}1f` : appTheme.colors.surface,
          paddingHorizontal: appTheme.spacing.gap,
          paddingVertical: 6,
        },
        style,
      ]}
    >
      {Icon ? <Icon color={color} size={appTheme.icon.compact} strokeWidth={2.2} /> : null}
      <AppText selectable={false} variant="label" color={color}>
        {label}
      </AppText>
    </View>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  accent,
  style,
}: {
  icon: IconComponent;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  accent?: ToolAccent;
  style?: StyleProp<ViewStyle>;
}) {
  const color = accent ? accentColor(accent) : appTheme.colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: appTheme.touch.compact,
          minWidth: appTheme.touch.compact,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: accent ? `${color}55` : appTheme.colors.border,
          borderRadius: appTheme.radii.pill,
          backgroundColor: accent ? `${color}1f` : appTheme.colors.surface,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
        },
        style,
      ]}
    >
      <Icon color={color} size={appTheme.icon.default} strokeWidth={2.2} />
    </Pressable>
  );
}

export function MediaFrame({
  children,
  aspectRatio = 1,
  accent,
  style,
}: {
  children: React.ReactNode;
  aspectRatio?: number;
  accent?: ToolAccent;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          aspectRatio,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: accent ? `${accentColor(accent)}44` : appTheme.colors.borderSubtle,
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          backgroundColor: appTheme.colors.surfaceInset,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function StatusBlock({
  tone = 'neutral',
  title,
  body,
}: {
  tone?: 'neutral' | 'success' | 'danger';
  title: string;
  body?: string;
}) {
  const color = tone === 'success' ? appTheme.colors.success : tone === 'danger' ? appTheme.colors.danger : appTheme.colors.muted;

  return (
    <Card variant="soft">
      <AppText variant="cardTitle" color={color}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="bodySm" color="muted">
          {body}
        </AppText>
      ) : null}
    </Card>
  );
}

export function WebLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href as never} asChild>
      <Pressable
        style={({ pressed }) => ({
          minHeight: appTheme.touch.compact,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: 1,
          borderColor: appTheme.colors.borderStrong,
          opacity: pressed ? appTheme.opacity.pressed : 1,
          paddingHorizontal: appTheme.spacing.card,
        })}
      >
        <AppText selectable={false} variant="label" color="text">{label}</AppText>
      </Pressable>
    </Link>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>{children}</View>;
}
