import { useId, useState } from 'react';
import { Link } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sparkles, X } from 'lucide-react-native';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { getAvatarInitial } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { haptic } from '@/lib/haptics';
import { useAnimatedState, usePressMotion } from '@/lib/motion';
import { appTheme, type ToolAccent, accentColor, onAccentColor } from '@/lib/theme';

type TextVariant = keyof typeof appTheme.type;
type ThemeColor = keyof typeof appTheme.colors;
type IconComponent = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
}>;

function resolveMotionView() {
  try {
    return Animated.View;
  } catch {
    // Keeps shared primitives usable under minimal react-native test mocks.
    return View;
  }
}

const MotionView = resolveMotionView() as typeof View;

type AppTextProps = Omit<TextProps, 'children' | 'numberOfLines' | 'selectable' | 'style'> & {
  children: React.ReactNode;
  variant?: TextVariant;
  color?: ThemeColor | string;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  heading?: boolean;
};

function textRole(variant: TextVariant): TextStyle {
  return appTheme.type[variant] as TextStyle;
}

/** Which Dynamic Type cap a variant follows — see `appTheme.typeScale`. */
function variantScaleCap(variant: TextVariant): number {
  if (variant === 'display' || variant === 'pageTitle' || variant === 'sectionTitle' || variant === 'metric') {
    return appTheme.typeScale.title;
  }
  if (variant === 'body' || variant === 'bodySm') {
    return appTheme.typeScale.body;
  }
  return appTheme.typeScale.control;
}

function colorValue(color: ThemeColor | string) {
  return color in appTheme.colors ? appTheme.colors[color as ThemeColor] : color;
}

function isHeadingVariant(variant: TextVariant) {
  return variant === 'display'
    || variant === 'pageTitle';
}

export function Screen({
  children,
  scroll = true,
  insideTab = false,
  keyboardAware = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  insideTab?: boolean;
  /**
   * Shrinks the scroll area with the keyboard so the focused field is scrolled
   * into view instead of being covered. Opt-in: it adds a wrapper view, and
   * only screens that actually take text input need it.
   */
  keyboardAware?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topPadding = appTheme.spacing.screen + (insideTab ? resolvedTopInset(insets.top) : 0);
  // `contentBottomPadding` clears the raised centre button as well as the bar;
  // the overlap variant only clears the bar, which leaves the last control
  // under the Create button — it is opaque and takes the tap regardless of the
  // bar's blur. Feeds want that overlap so media runs to the edge, but `Screen`
  // is always a gutter-padded container, never edge-to-edge media.
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

  const scroller = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
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

  if (!keyboardAware) return scroller;

  return (
    <KeyboardAvoidingArea iosScrollViewAdjustsInsets style={{ backgroundColor: appTheme.colors.background }}>
      {scroller}
    </KeyboardAvoidingArea>
  );
}

export function AppText({
  children,
  variant = 'body',
  color = 'text',
  selectable,
  style,
  numberOfLines,
  heading = false,
  accessibilityRole,
  maxFontSizeMultiplier,
  ...textProps
}: AppTextProps) {
  // Android drops `numberOfLines` truncation when the text is selectable: it
  // lays the full string out and draws the extra lines past the single-line box
  // it measured, so a long title spills over whatever sits beneath it instead
  // of ellipsizing. Truncation is a layout guarantee and selection is a nicety,
  // so capped text stops being selectable unless a caller insists.
  const isSelectable = selectable ?? numberOfLines === undefined;

  return (
    <Text
      {...textProps}
      accessibilityRole={accessibilityRole ?? (heading || isHeadingVariant(variant) ? 'header' : undefined)}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? variantScaleCap(variant)}
      selectable={isSelectable}
      numberOfLines={numberOfLines}
      style={[textRole(variant), { color: colorValue(color) }, style]}
    >
      {children}
    </Text>
  );
}

/**
 * The product's name, drawn once.
 *
 * Before S3 this lockup existed four times — the onboarding welcome (29pt
 * glyph beside 25pt/800 text), the onboarding goal header (26/23), the home
 * side menu (24 filled, beside 20/800) and the auth screen (20/19/700) — so a
 * person moving welcome → goal → auth met the app's name at three sizes in
 * three taps. Design principles/Familiarity: "once you establish a behavior or
 * appearance for an element, apply it throughout your design."
 *
 * Two sizes, both on the icon and type ramps: `compact` for chrome that has
 * other work to do, `hero` for the welcome screen, where the name is the
 * content. The wordmark takes the display face, which is what Branding asks a
 * custom font to carry — and, being a display variant, it must never be given a
 * `fontWeight` (see `hig-type-and-contrast.test.ts`).
 */
export function BrandLockup({ size = 'compact' }: { size?: 'compact' | 'hero' }) {
  const hero = size === 'hero';

  return (
    <View
      accessibilityRole="header"
      accessibilityLabel="Magicbooklet"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: hero ? appTheme.spacing.compact : 7,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      <Sparkles size={hero ? appTheme.icon.hero : appTheme.icon.feature} color={appTheme.colors.primary} />
      <AppText
        selectable={false}
        numberOfLines={1}
        variant={hero ? 'pageTitle' : 'sectionTitle'}
        accessibilityRole="none"
        style={{ flexShrink: 1 }}
      >
        Magicbooklet
      </AppText>
    </View>
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
          <AppText heading variant="pageTitle">{title}</AppText>
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
          <AppText heading variant="cardTitle">{title}</AppText>
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
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedControl });

  return (
    <SurfaceSection
      eyebrow={expanded ? 'Expanded' : 'Collapsed'}
      title={title}
      body={body}
      accent={accent}
      action={(
        <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
            accessibilityHint={expanded ? 'Hides this section' : 'Shows this section'}
            accessibilityState={{ expanded }}
            onBlur={motion.onBlur}
            onFocus={motion.onFocus}
            onPress={onToggle}
            onPressIn={motion.onPressIn}
            onPressOut={motion.onPressOut}
            style={({ pressed }) => ({
              minHeight: appTheme.touch.default,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: motion.focused ? appTheme.state.focus.width : 1,
              borderColor: motion.focused ? appTheme.state.focus.color : `${color}55`,
              borderRadius: appTheme.radii.pill,
              backgroundColor: `${color}1f`,
              opacity: pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: appTheme.spacing.card,
            })}
          >
            <AppText selectable={false} variant="label" color={color}>
              {expanded ? 'Hide' : 'Show'}
            </AppText>
          </Pressable>
        </MotionView>
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
  const motion = usePressMotion(disabled);

  return (
    <MotionView
      style={[
        grow ? { flex: 1 } : null,
        motion.animatedStyle as StyleProp<ViewStyle>,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active, disabled }}
        disabled={disabled}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={() => {
          // A chip that is already active is a no-op; only a real change ticks.
          if (!active) haptic.select();
          onPress();
        }}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          flex: grow ? 1 : undefined,
          minHeight: appTheme.touch.default,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: motion.focused ? appTheme.state.focus.width : 1,
          borderColor: motion.focused
            ? appTheme.state.focus.color
            : active
              ? accent === 'primary' ? appTheme.state.selected.border : `${color}8a`
              : appTheme.colors.border,
          backgroundColor: active
            ? accent === 'primary' ? appTheme.state.selected.background : `${color}20`
            : pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
          opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
          paddingHorizontal: compact ? appTheme.spacing.gap : appTheme.spacing.card,
        })}
      >
        <AppText
          selectable={false}
          variant={compact ? 'caption' : 'label'}
          color={active ? appTheme.colors.text : appTheme.colors.muted}
          numberOfLines={1}
          style={{ fontWeight: active ? '800' : '700' }}
        >
          {label}
        </AppText>
      </Pressable>
    </MotionView>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  body,
  accent,
  onPress,
  trailing,
  compact = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  body?: string;
  accent?: ToolAccent;
  onPress?: () => void;
  trailing?: React.ReactNode;
  compact?: boolean;
}) {
  const motion = usePressMotion(!onPress);
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
      {trailing ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: compact ? 13 : 17,
            right: compact ? 12 : 16,
          }}
        >
          {trailing}
        </View>
      ) : null}
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
    <MotionView style={[{ flex: 1 }, motion.animatedStyle as StyleProp<ViewStyle>]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityHint={body}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({ flex: 1, opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <Card
          accent={accent}
          padding="sm"
          style={[
            { minHeight: compact ? 76 : 104 },
            motion.focused
              ? { borderColor: appTheme.state.focus.color, borderWidth: appTheme.state.focus.width }
              : null,
          ]}
        >
          {content}
        </Card>
      </Pressable>
    </MotionView>
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
  const semantic = state === 'ready'
    ? appTheme.semantic.success
    : state === 'warning'
      ? appTheme.semantic.warning
      : state === 'danger'
        ? appTheme.semantic.danger
        : appTheme.semantic.neutral;

  return (
    <View
      accessible
      accessibilityLabel={`${label}. ${body}`}
      accessibilityLiveRegion={state === 'danger' ? 'assertive' : 'polite'}
      accessibilityRole={state === 'danger' ? 'alert' : 'summary'}
      style={{
        minHeight: appTheme.touch.default,
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.gap,
        borderRadius: appTheme.radii.md,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: semantic.border,
        backgroundColor: semantic.background,
        paddingHorizontal: appTheme.spacing.gap,
        paddingVertical: appTheme.spacing.compact,
      }}
    >
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: semantic.foreground }} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText selectable={false} variant="label" color={semantic.foreground}>
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
  const motion = usePressMotion(disabled);
  const progress = useAnimatedState(value);
  const thumbTranslate = progress?.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 18],
  });

  return (
    <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityHint={body}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={() => {
          haptic.select();
          onValueChange(!value);
        }}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: appTheme.touch.roomy,
          borderRadius: appTheme.radii.lg,
          borderCurve: 'continuous',
          borderWidth: motion.focused ? appTheme.state.focus.width : 1,
          borderColor: motion.focused
            ? appTheme.state.focus.color
            : value ? `${color}66` : appTheme.colors.border,
          backgroundColor: value ? `${color}16` : pressed ? appTheme.colors.pressed : appTheme.colors.surfaceStrong,
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
            width: 48,
            height: 30,
            borderRadius: 15,
            borderWidth: 1,
            borderColor: value ? `${color}88` : appTheme.colors.borderStrong,
            backgroundColor: value ? `${color}30` : appTheme.colors.surfaceInset,
            justifyContent: 'center',
            paddingHorizontal: 3,
          }}
        >
          <MotionView
            style={{
            width: 22,
            height: 22,
            borderRadius: 11,
              backgroundColor: value ? color : appTheme.colors.muted,
              transform: thumbTranslate ? [{ translateX: thumbTranslate }] : undefined,
          }}
          />
        </View>
      </Pressable>
    </MotionView>
  );
}

export function BottomActionDock({
  children,
  eyebrow = 'Publish dock',
  title,
  body,
  accent = 'primary',
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
        <AppText heading variant="cardTitle">{title}</AppText>
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
  loadingLabel,
  onPress,
  disabled,
  loading,
  accent = 'primary',
  size = 'default',
  accessibilityHint,
}: {
  label: string;
  /**
   * What the button says while it waits. HIG Buttons: "you can also configure
   * the button to display a different label alongside the activity indicator …
   * the label 'Checkout' could change to 'Checking out…'". Without it the
   * button falls back to a bare spinner, which is the older behaviour and
   * still correct for actions too short to need narrating.
   */
  loadingLabel?: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  accent?: ToolAccent;
  size?: 'default' | 'roomy';
  accessibilityHint?: string;
}) {
  const fillColor = accentColor(accent);
  const unavailable = Boolean(disabled || loading);
  const textColor = disabled
    ? appTheme.colors.muted
    : onAccentColor(accent);
  const motion = usePressMotion(unavailable);

  return (
    <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityLiveRegion={loading ? 'polite' : 'none'}
        accessibilityState={{ busy: Boolean(loading), disabled: unavailable }}
        disabled={unavailable}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={() => {
          haptic.light();
          onPress?.();
        }}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: size === 'roomy' ? appTheme.touch.roomy : appTheme.touch.default,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: appTheme.state.focus.width,
          borderColor: motion.focused ? appTheme.state.focus.color : 'transparent',
          backgroundColor: disabled ? appTheme.colors.panelSoft : fillColor,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
          paddingHorizontal: appTheme.spacing.panel,
        })}
      >
        {loading && !loadingLabel ? (
          <ActivityIndicator color={textColor} />
        ) : loading ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>
            <ActivityIndicator color={textColor} />
            <AppText selectable={false} variant="button" color={textColor}>{loadingLabel}</AppText>
          </View>
        ) : (
          <AppText selectable={false} variant="button" color={textColor}>{label}</AppText>
        )}
      </Pressable>
    </MotionView>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const motion = usePressMotion(Boolean(disabled));

  return (
    <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: appTheme.touch.default,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: motion.focused ? appTheme.state.focus.width : 1,
          borderColor: motion.focused ? appTheme.state.focus.color : appTheme.colors.border,
          backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.panelSoft,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
          paddingHorizontal: appTheme.spacing.card,
        })}
      >
        <AppText selectable={false} variant="label" color="text">{label}</AppText>
      </Pressable>
    </MotionView>
  );
}

/** Width reserved beside the text for a trailing in-field control. */
const FIELD_CONTROL_SIZE = MIN_HIT_TARGET_PT;

export function AppTextInput({
  label,
  multiline,
  accessibilityLabel,
  accessibilityLabelledBy,
  accessibilityState,
  editable,
  error,
  footer,
  hint,
  hintTone = 'muted',
  inputRef,
  onBlur,
  onClear,
  onFocus,
  placeholderTextColor = appTheme.colors.faint,
  style,
  value,
  ...props
}: TextInputProps & {
  label: string;
  /**
   * What is wrong with the current value. Draws the danger border and an
   * announced message under the field — Feedback asks you to "show people when
   * a command can't be carried out and help them understand why", and a field
   * that only turns red has said the first half.
   */
  error?: string;
  /** Right-aligned on the label row. A character count, typically. */
  footer?: string;
  /** A standing line under the field: what the field wants, or how it is doing. */
  hint?: string;
  hintTone?: 'muted' | 'success' | 'danger';
  /**
   * Clears the field. Text fields, iOS: "Display a Clear button in the trailing
   * end of a text field to help people erase their input." Drawn rather than
   * left to `clearButtonMode`, which exists only on iOS — this is the same
   * control on both platforms. Single-line fields only.
   */
  onClear?: () => void;
  /** Lets a caller move focus to this field, e.g. from the previous field's Return key. */
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const generatedId = useId();
  const labelId = `field-label-${generatedId.replace(/:/g, '')}`;
  const [focused, setFocused] = useState(false);
  const disabled = editable === false;
  const showClear = Boolean(onClear) && !multiline && !disabled && Boolean(value);
  const message = error ?? hint;
  const messageColor = error ? 'danger' : hintTone;

  return (
    <View style={{ gap: appTheme.spacing.compact }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: appTheme.spacing.compact }}>
        <AppText
          nativeID={labelId}
          variant="label"
          color="textSecondary"
          style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}
        >
          {label}
        </AppText>
        {footer ? (
          <AppText variant="caption" color="faint" style={{ fontVariant: ['tabular-nums'] }}>
            {footer}
          </AppText>
        ) : null}
      </View>
      <View style={{ justifyContent: 'center' }}>
        <TextInput
          {...props}
          ref={inputRef}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityLabelledBy={accessibilityLabelledBy ?? labelId}
          accessibilityState={{ ...accessibilityState, disabled }}
          aria-invalid={Boolean(error)}
          maxFontSizeMultiplier={appTheme.typeScale.control}
          editable={editable}
          multiline={multiline}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          placeholderTextColor={placeholderTextColor}
          selectionColor={appTheme.colors.primary}
          textAlignVertical={multiline ? 'top' : 'center'}
          value={value}
          style={[
            {
              minHeight: multiline ? 120 : appTheme.touch.default,
              // Border width stays put and the focus ring is drawn as an outline
              // outside the box. Growing the border on focus instead would resize
              // the field and nudge its text by a pixel on every tap.
              borderWidth: 1,
              borderColor: error
                ? appTheme.colors.danger
                : focused ? appTheme.state.focus.color : appTheme.colors.border,
              outlineStyle: 'solid',
              outlineColor: appTheme.state.focus.color,
              outlineWidth: focused ? appTheme.state.focus.width : 0,
              borderRadius: appTheme.radii.md,
              borderCurve: 'continuous',
              backgroundColor: disabled ? appTheme.colors.surface : appTheme.colors.surfaceInset,
              color: disabled ? appTheme.colors.muted : appTheme.colors.text,
              ...textRole('bodySm'),
              paddingHorizontal: appTheme.spacing.card,
              paddingVertical: appTheme.spacing.gap,
            },
            showClear ? { paddingRight: FIELD_CONTROL_SIZE } : null,
            style,
          ]}
        />
        {showClear ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label.toLowerCase()}`}
            onPress={onClear}
            style={({ pressed }) => ({
              position: 'absolute',
              right: 0,
              width: FIELD_CONTROL_SIZE,
              height: FIELD_CONTROL_SIZE,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <X size={appTheme.icon.compact} color={appTheme.colors.muted} />
          </Pressable>
        ) : null}
      </View>
      {message ? (
        <AppText
          accessibilityRole={error ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          variant="caption"
          color={messageColor}
        >
          {message}
        </AppText>
      ) : null}
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
      accessible
      accessibilityLabel={label}
      accessibilityRole="text"
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
      {Icon ? <Icon color={color} size={appTheme.icon.compact} /> : null}
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
  accessibilityHint,
}: {
  icon: IconComponent;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  accent?: ToolAccent;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const color = accent ? accentColor(accent) : appTheme.colors.text;
  const motion = usePressMotion(Boolean(disabled), { scale: appTheme.motion.scale.pressedControl });

  return (
    <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => [
          {
            minHeight: appTheme.touch.default,
            minWidth: appTheme.touch.default,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: motion.focused ? appTheme.state.focus.width : 1,
            borderColor: motion.focused
              ? appTheme.state.focus.color
              : accent ? `${color}55` : appTheme.colors.border,
            borderRadius: appTheme.radii.pill,
            backgroundColor: accent
              ? `${color}1f`
              : pressed ? appTheme.colors.pressed : appTheme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
          },
          style,
        ]}
      >
        <Icon color={color} size={appTheme.icon.default} />
      </Pressable>
    </MotionView>
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
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body?: string;
}) {
  const semantic = appTheme.semantic[tone];

  return (
    <View
      accessible
      accessibilityLabel={body ? `${title}. ${body}` : title}
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
    >
      <Card
        variant="soft"
        style={{ borderColor: semantic.border, backgroundColor: semantic.background }}
      >
        <AppText variant="cardTitle" color={semantic.foreground}>
          {title}
        </AppText>
        {body ? (
          <AppText variant="bodySm" color="textSecondary">
            {body}
          </AppText>
        ) : null}
      </Card>
    </View>
  );
}

export function WebLinkButton({
  href,
  label,
  accessibilityHint,
}: {
  href: string;
  label: string;
  accessibilityHint?: string;
}) {
  const motion = usePressMotion();

  return (
    <MotionView style={motion.animatedStyle as StyleProp<ViewStyle>}>
      <Link href={href as never} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={label}
          accessibilityHint={accessibilityHint ?? 'Opens in your browser'}
          onBlur={motion.onBlur}
          onFocus={motion.onFocus}
          onPressIn={motion.onPressIn}
          onPressOut={motion.onPressOut}
          style={({ pressed }) => ({
            minHeight: appTheme.touch.default,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: appTheme.radii.pill,
            borderWidth: motion.focused ? appTheme.state.focus.width : 1,
            borderColor: motion.focused ? appTheme.state.focus.color : appTheme.colors.borderStrong,
            backgroundColor: pressed ? appTheme.colors.pressed : appTheme.colors.surface,
            opacity: pressed ? appTheme.opacity.pressed : 1,
            paddingHorizontal: appTheme.spacing.card,
          })}
        >
          <AppText selectable={false} variant="label" color="text">{label}</AppText>
        </Pressable>
      </Link>
    </MotionView>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: appTheme.spacing.compact }}>{children}</View>;
}

export function CreatorAvatar({
  uri,
  name,
  size = 25,
}: {
  uri: string | null;
  name: string;
  size?: number;
}) {
  const initial = getAvatarInitial(name);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: appTheme.colors.panelSoft,
      }}
    >
      {/* The initial is drawn whether or not there is a photo, and the photo
          covers it once it arrives. Rendered only in the photo's absence, a
          cold post page showed a blank disc where a face was about to be —
          HIG Images asks a placeholder to stand in while content loads. */}
      <Text style={{ color: appTheme.colors.text, fontSize: Math.max(10, Math.round(size * 0.44)), fontWeight: '800' }}>
        {initial}
      </Text>
      {uri ? (
        <Image source={{ uri }} resizeMode="cover" style={{ position: 'absolute', inset: 0 }} />
      ) : null}
    </View>
  );
}
