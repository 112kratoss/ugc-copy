import { isValidElement, useId, useState, type Ref } from 'react';
import { MediaViewportScrollView as ScrollView } from '@/components/media-viewport-scroll-view';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sparkles, X } from 'lucide-react-native';

import { KeyboardAvoidingArea } from '@/components/keyboard-aware';
import { useDisplayFontLoaded } from '@/lib/display-font-ready';
import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import { getAvatarInitial } from '@/lib/profile-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { haptic } from '@/lib/haptics';
import { useAnimatedState, usePressMotion } from '@/lib/motion';
import { appTheme, type ThemeColorName, type ThemeColors, type ToolAccent, accentColor, accentFill, onAccentFill } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

type TextVariant = keyof typeof appTheme.type;
type ThemeColor = ThemeColorName;
type IconComponent = React.ComponentType<{
  color?: string;
  size?: number;
  strokeWidth?: number;
}>;
/**
 * What a button draws beside its label: an icon, which the button colours and
 * sizes with the label, or an element the caller draws itself (`SaveHeart`,
 * whose pop is its own).
 */
type ButtonIcon = IconComponent | React.ReactElement;

function ButtonGlyph({ icon, color, size }: { icon?: ButtonIcon; color: string; size: number }) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Icon = icon;
  return <Icon color={color} size={size} />;
}

function resolveMotionView() {
  try {
    return Animated.View ?? View;
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
  /** The text itself, for a screen reader to be moved onto it. */
  ref?: Ref<Text>;
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

function colorValue(color: ThemeColor | string, colors: ThemeColors) {
  return color in colors ? colors[color as ThemeColor] : color;
}

function isHeadingVariant(variant: TextVariant) {
  return variant === 'display'
    || variant === 'pageTitle';
}

export function Screen({
  children,
  scroll = true,
  insideTab = false,
  safeTop = false,
  keyboardAware = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  insideTab?: boolean;
  /**
   * Clears the status bar on a stack screen shown without a header, which
   * `insideTab` also does but alongside the tab bar's bottom padding.
   */
  safeTop?: boolean;
  /**
   * Shrinks the scroll area with the keyboard so the focused field is scrolled
   * into view instead of being covered. Opt-in: it adds a wrapper view, and
   * only screens that actually take text input need it.
   */
  keyboardAware?: boolean;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topPadding = appTheme.spacing.screen + (insideTab || safeTop ? resolvedTopInset(insets.top) : 0);
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
          backgroundColor: theme.colors.background,
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
      style={{ flex: 1, backgroundColor: theme.colors.background }}
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
    <KeyboardAvoidingArea iosScrollViewAdjustsInsets style={{ backgroundColor: theme.colors.background }}>
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
  ref,
  ...textProps
}: AppTextProps) {
  const theme = useAppTheme();
  const displayFontLoaded = useDisplayFontLoaded();
  // Android drops `numberOfLines` truncation when the text is selectable: it
  // lays the full string out and draws the extra lines past the single-line box
  // it measured, so a long title spills over whatever sits beneath it instead
  // of ellipsizing. Truncation is a layout guarantee and selection is a nicety,
  // so capped text stops being selectable unless a caller insists.
  const isSelectable = selectable ?? numberOfLines === undefined;
  // A role in the display face is drawn anew once the face has loaded: the
  // screens render before it does, and on Android text drawn before that
  // keeps the system face until it is drawn again (`lib/display-font-ready.ts`).
  const faceKey = textRole(variant).fontFamily
    ? (displayFontLoaded ? 'display-face' : 'system-face')
    : undefined;

  return (
    <Text
      key={faceKey}
      {...textProps}
      ref={ref}
      accessibilityRole={accessibilityRole ?? (heading || isHeadingVariant(variant) ? 'header' : undefined)}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? variantScaleCap(variant)}
      selectable={isSelectable}
      numberOfLines={numberOfLines}
      style={[textRole(variant), { color: colorValue(color, theme.colors) }, style]}
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
  const theme = useAppTheme();
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
      <Sparkles size={hero ? appTheme.icon.hero : appTheme.icon.feature} color={theme.colors.primary} />
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
  const theme = useAppTheme();
  const paddingValue = {
    sm: appTheme.spacing.gap,
    md: appTheme.spacing.card,
    lg: appTheme.spacing.panel,
  }[padding];
  const backgroundColor = {
    default: theme.colors.panel,
    soft: theme.colors.surface,
    inset: theme.colors.surfaceInset,
  }[variant];

  return (
    <View
      style={[
        {
          gap: appTheme.spacing.gap,
          borderWidth: 1,
          borderColor: accent ? `${accentColor(accent, theme.colors)}55` : theme.colors.borderSubtle,
          backgroundColor,
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          padding: paddingValue,
        },
        variant === 'default' ? (theme.shadow.panel as ViewStyle) : null,
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
  const theme = useAppTheme();
  return (
    <Card accent={accent} style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: appTheme.spacing.gap }}>
        <View style={{ flex: 1, gap: 5 }}>
          {eyebrow ? <Kicker color={accent ? accentColor(accent, theme.colors) : 'faint'}>{eyebrow}</Kicker> : null}
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
  const theme = useAppTheme();
  const color = accent ? accentColor(accent, theme.colors) : theme.colors.textSecondary;
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
              borderWidth: motion.focused ? theme.state.focus.width : 1,
              borderColor: motion.focused ? theme.state.focus.color : `${color}55`,
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
  const theme = useAppTheme();
  const color = accentColor(accent, theme.colors);
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
          borderWidth: motion.focused ? theme.state.focus.width : 1,
          borderColor: motion.focused
            ? theme.state.focus.color
            : active
              ? accent === 'primary' ? theme.state.selected.border : `${color}8a`
              : theme.colors.border,
          backgroundColor: active
            ? accent === 'primary' ? theme.state.selected.background : `${color}20`
            : pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
          opacity: disabled ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
          paddingHorizontal: compact ? appTheme.spacing.gap : appTheme.spacing.card,
        })}
      >
        <AppText
          selectable={false}
          variant={compact ? 'caption' : 'label'}
          color={active ? theme.colors.text : theme.colors.muted}
          numberOfLines={1}
          style={{ fontWeight: active ? '800' : '700' }}
        >
          {label}
        </AppText>
      </Pressable>
    </MotionView>
  );
}

/** The clearance between a segmented control's track and its thumbs, on every side. */
const SEGMENT_INSET = appTheme.spacing.unit;
/** The track's hairline. */
const SEGMENT_TRACK_BORDER = 1;
/**
 * The control is as tall as a button beside it (`touch.default`), so a thumb is
 * drawn 4pt inside the track and each segment answers to the track's full
 * height through its slop: a 48pt hit region on a 38pt capsule.
 */
const SEGMENT_THUMB_HEIGHT = appTheme.touch.default - 2 * (SEGMENT_INSET + SEGMENT_TRACK_BORDER);
const SEGMENT_HIT_SLOP = {
  top: SEGMENT_INSET + SEGMENT_TRACK_BORDER,
  bottom: SEGMENT_INSET + SEGMENT_TRACK_BORDER,
  left: SEGMENT_INSET / 2,
  right: SEGMENT_INSET / 2,
};

export type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
  /** Spoken in the label's place when the drawn word needs its context ("Switch to sign up"). */
  accessibilityLabel?: string;
};

/**
 * One choice among two to five closely related options, drawn once for the
 * whole app: a capsule track in the inset fill with a hairline, and the choice
 * in use a coral capsule 4pt inside it, so the two curves share a centre.
 * Until November 2026 the app drew this control by hand seven times, with three
 * track fills, three label sizes and haptics on two of them.
 *
 * `role` says what a choice does. `radio` picks a setting (Appearance, a
 * draft's shot mode); `tab` switches the view below the control (Profile's
 * collections, sign in or sign up, the comment order). Segmented controls:
 * "Consider a segmented control to switch between closely related subviews."
 *
 * `fill` shares the row equally, as the HIG prefers ("keep segment size
 * consistent"); `fill={false}` sizes each segment to its label, for a control
 * beside a title or another control. A label stays on one line and shrinks a
 * little before it would truncate, as counts in a third of a phone's width do
 * at large text sizes.
 *
 * Choosing the segment already in use does nothing, and only a real change
 * ticks (`haptic.select`).
 */
export function SegmentedControl<Value extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  role = 'radio',
  fill = true,
  disabled = false,
  style,
  testID,
}: {
  options: readonly SegmentedControlOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Names the group for a screen reader: "Appearance", "Sort comments". */
  accessibilityLabel?: string;
  role?: 'radio' | 'tab';
  fill?: boolean;
  disabled?: boolean;
  /** Where the control sits: margins, `alignSelf`, a width. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useAppTheme();
  const tabs = role === 'tab';

  return (
    <View
      testID={testID}
      accessibilityRole={tabs ? 'tablist' : 'radiogroup'}
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          gap: SEGMENT_INSET,
          padding: SEGMENT_INSET,
          borderRadius: appTheme.radii.pill,
          borderWidth: SEGMENT_TRACK_BORDER,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceInset,
          opacity: disabled ? appTheme.opacity.disabled : 1,
        },
        style,
      ]}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole={tabs ? 'tab' : 'radio'}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={tabs ? { selected: active, disabled } : { checked: active, disabled }}
            disabled={disabled}
            hitSlop={SEGMENT_HIT_SLOP}
            onPress={() => {
              if (active) return;
              haptic.select();
              onChange(option.value);
            }}
            style={({ pressed }) => ({
              flex: fill ? 1 : undefined,
              minWidth: fill ? undefined : appTheme.touch.default,
              minHeight: SEGMENT_THUMB_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: appTheme.radii.pill,
              backgroundColor: active ? theme.colors.primaryFill : pressed ? theme.colors.pressed : 'transparent',
              opacity: pressed ? appTheme.opacity.pressed : 1,
              paddingHorizontal: fill ? appTheme.spacing.compact : appTheme.spacing.gap,
            })}
          >
            <AppText
              selectable={false}
              variant="label"
              color={active ? 'onPrimary' : 'muted'}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
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
  const theme = useAppTheme();
  const motion = usePressMotion(!onPress);
  const content = (
    <>
      {icon ? (
        <View
          style={{
            width: compact ? 34 : 42,
            height: compact ? 34 : 42,
            borderRadius: appTheme.radii.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: accent ? `${accentColor(accent, theme.colors)}1f` : theme.colors.surfaceStrong,
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
              ? { borderColor: theme.state.focus.color, borderWidth: theme.state.focus.width }
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
  const theme = useAppTheme();
  const semantic = state === 'ready'
    ? theme.semantic.success
    : state === 'warning'
      ? theme.semantic.warning
      : state === 'danger'
        ? theme.semantic.danger
        : theme.semantic.neutral;

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
      <View style={{ width: 9, height: 9, borderRadius: appTheme.radii.pill, backgroundColor: semantic.foreground }} />
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
  const theme = useAppTheme();
  const color = accentColor(accent, theme.colors);
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
          borderWidth: motion.focused ? theme.state.focus.width : 1,
          borderColor: motion.focused
            ? theme.state.focus.color
            : value ? `${color}66` : theme.colors.border,
          backgroundColor: value ? `${color}16` : pressed ? theme.colors.pressed : theme.colors.surfaceStrong,
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
          <AppText selectable={false} variant="label" color={value ? color : theme.colors.text}>
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
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: value ? `${color}88` : theme.colors.borderStrong,
            backgroundColor: value ? `${color}30` : theme.colors.surfaceInset,
            justifyContent: 'center',
            paddingHorizontal: 3,
          }}
        >
          <MotionView
            style={{
            width: 22,
            height: 22,
            borderRadius: appTheme.radii.pill,
              backgroundColor: value ? accentFill(accent) : theme.colors.muted,
              transform: thumbTranslate ? [{ translateX: thumbTranslate }] : undefined,
          }}
          />
        </View>
      </Pressable>
    </MotionView>
  );
}

/**
 * What a button draws: its label alone, or the label between its glyphs. While
 * it waits, the activity indicator takes the leading glyph's place, beside the
 * waiting label when there is one (HIG Buttons: "the system displays the
 * activity indicator next to the original or alternative label, hiding the
 * button image").
 */
function ButtonContent({
  label,
  loading,
  loadingLabel,
  icon,
  trailingIcon,
  variant,
  color,
  iconSize,
}: {
  label: string;
  loading: boolean;
  loadingLabel?: string;
  icon?: ButtonIcon;
  trailingIcon?: ButtonIcon;
  variant: 'button' | 'label';
  color: string;
  iconSize: number;
}) {
  if (loading && !loadingLabel) return <ActivityIndicator color={color} />;
  const text = loading ? loadingLabel : label;
  if (!loading && !icon && !trailingIcon) {
    return <AppText selectable={false} variant={variant} color={color}>{text}</AppText>;
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: appTheme.spacing.compact }}>
      {loading ? <ActivityIndicator color={color} /> : <ButtonGlyph icon={icon} color={color} size={iconSize} />}
      <AppText selectable={false} variant={variant} color={color} style={{ flexShrink: 1, textAlign: 'center' }}>{text}</AppText>
      {loading ? null : <ButtonGlyph icon={trailingIcon} color={color} size={iconSize} />}
    </View>
  );
}

type ButtonProps = {
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
  /** Before the label; the spinner's place while the button waits. */
  icon?: ButtonIcon;
  /** After the label: a chevron that says where the button goes. */
  trailingIcon?: ButtonIcon;
  /** `roomy` for the one action that closes a screen or a sheet, in its footer. */
  size?: 'default' | 'roomy';
  /** The spoken name, when the drawn label is a number or needs its context. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: PressableProps['accessibilityValue'];
  /** Where the button sits: `flex`, `alignSelf`, margins. Never its look. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function PrimaryButton({
  label,
  loadingLabel,
  onPress,
  disabled,
  loading,
  accent = 'primary',
  size = 'default',
  icon,
  trailingIcon,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  style,
  testID,
}: ButtonProps & { accent?: ToolAccent }) {
  const theme = useAppTheme();
  const fillColor = accentFill(accent);
  const unavailable = Boolean(disabled || loading);
  const textColor = disabled
    ? theme.colors.muted
    : onAccentFill(accent);
  const motion = usePressMotion(unavailable);

  return (
    <MotionView style={[style, motion.animatedStyle as StyleProp<ViewStyle>]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
        accessibilityValue={accessibilityValue}
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
          borderWidth: theme.state.focus.width,
          borderColor: motion.focused ? theme.state.focus.color : 'transparent',
          backgroundColor: disabled ? theme.colors.panelSoft : fillColor,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
          paddingHorizontal: appTheme.spacing.panel,
        })}
      >
        <ButtonContent
          label={label}
          loading={Boolean(loading)}
          loadingLabel={loadingLabel}
          icon={icon}
          trailingIcon={trailingIcon}
          variant="button"
          color={textColor}
          iconSize={appTheme.icon.compact}
        />
      </Pressable>
    </MotionView>
  );
}

/**
 * A supporting action: never competes with the primary. Neutral by default; an
 * `accent` tints it (the accent's wash and hairline, its label in the accent),
 * for an action that belongs to one tool, such as enhancing a shot.
 */
export function SecondaryButton({
  label,
  loadingLabel,
  onPress,
  disabled,
  loading,
  accent,
  size = 'default',
  icon,
  trailingIcon,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  style,
  testID,
}: ButtonProps & { accent?: ToolAccent }) {
  const theme = useAppTheme();
  const unavailable = Boolean(disabled || loading);
  const motion = usePressMotion(unavailable);
  const tint = accent ? accentColor(accent, theme.colors) : null;
  const textColor = tint ?? theme.colors.text;

  return (
    <MotionView style={[style, motion.animatedStyle as StyleProp<ViewStyle>]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
        accessibilityValue={accessibilityValue}
        accessibilityLiveRegion={loading ? 'polite' : 'none'}
        accessibilityState={{ busy: Boolean(loading), disabled: unavailable }}
        disabled={unavailable}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: size === 'roomy' ? appTheme.touch.roomy : appTheme.touch.default,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: motion.focused ? theme.state.focus.width : 1,
          borderColor: motion.focused ? theme.state.focus.color : tint ? `${tint}55` : theme.colors.border,
          backgroundColor: tint ? `${tint}1f` : pressed ? theme.colors.pressed : theme.colors.panelSoft,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
          paddingHorizontal: appTheme.spacing.card,
        })}
      >
        <ButtonContent
          label={label}
          loading={Boolean(loading)}
          loadingLabel={loadingLabel}
          icon={icon}
          trailingIcon={trailingIcon}
          variant="label"
          color={textColor}
          iconSize={appTheme.icon.sm}
        />
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
  containerRef,
  onBlur,
  onClear,
  onFocus,
  placeholderTextColor,
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
  /** The whole field, label to message: what a caller measures to bring the field into view. */
  containerRef?: React.Ref<View>;
}) {
  const theme = useAppTheme();
  const generatedId = useId();
  const labelId = `field-label-${generatedId.replace(/:/g, '')}`;
  const [focused, setFocused] = useState(false);
  const disabled = editable === false;
  const showClear = Boolean(onClear) && !multiline && !disabled && Boolean(value);
  const message = error ?? hint;
  const messageColor = error ? 'danger' : hintTone;

  return (
    <View ref={containerRef} style={{ gap: appTheme.spacing.compact }}>
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
          placeholderTextColor={placeholderTextColor ?? theme.colors.faint}
          selectionColor={theme.colors.primary}
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
                ? theme.colors.danger
                : focused ? theme.state.focus.color : theme.colors.border,
              outlineStyle: 'solid',
              outlineColor: theme.state.focus.color,
              outlineWidth: focused ? theme.state.focus.width : 0,
              borderRadius: appTheme.radii.md,
              borderCurve: 'continuous',
              backgroundColor: disabled ? theme.colors.surface : theme.colors.surfaceInset,
              color: disabled ? theme.colors.muted : theme.colors.text,
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
            <X size={appTheme.icon.compact} color={theme.colors.muted} />
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
  const theme = useAppTheme();
  const color = accent ? accentColor(accent, theme.colors) : theme.colors.textSecondary;

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
          borderColor: accent ? `${color}55` : theme.colors.borderSubtle,
          borderRadius: appTheme.radii.pill,
          backgroundColor: accent ? `${color}1f` : theme.colors.surface,
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

/**
 * An icon-only control: a 48pt circle, the glyph at `icon.feature`, the size
 * every Back and Close in the app is drawn at (`lib/platform-glyphs.ts`). It
 * takes the filled circle iOS draws a Close button in. `plain` leaves the
 * circle out until it is pressed, for a button in a header bar whose own
 * surface already holds it (HIG Buttons: a button in a toolbar is the exception
 * to "prefer buttons that have a discernible background shape and fill").
 */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  busy = false,
  accent,
  variant = 'filled',
  style,
  accessibilityHint,
  testID,
}: {
  icon: IconComponent;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** Announced while the press is still being acted on (closing a draft that saves first). */
  busy?: boolean;
  accent?: ToolAccent;
  variant?: 'filled' | 'plain';
  /** Where the button sits: margins, `alignSelf`, an absolute position. Never its look. */
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  testID?: string;
}) {
  const theme = useAppTheme();
  const tint = accent ? accentColor(accent, theme.colors) : null;
  const motion = usePressMotion(Boolean(disabled), { scale: appTheme.motion.scale.pressedControl });
  const restingFill = tint ? `${tint}1f` : variant === 'plain' ? 'transparent' : theme.colors.surfaceStrong;

  return (
    <MotionView style={[style, motion.animatedStyle as StyleProp<ViewStyle>]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ busy, disabled: Boolean(disabled) }}
        disabled={disabled}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: appTheme.touch.default,
          minWidth: appTheme.touch.default,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: appTheme.radii.pill,
          borderWidth: theme.state.focus.width,
          borderColor: motion.focused ? theme.state.focus.color : 'transparent',
          backgroundColor: pressed && !tint ? theme.colors.pressed : restingFill,
          opacity: pressed ? appTheme.opacity.pressed : disabled ? appTheme.opacity.disabled : 1,
        })}
      >
        <Icon color={tint ?? theme.colors.text} size={appTheme.icon.feature} />
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
  const theme = useAppTheme();
  return (
    <View
      style={[
        {
          aspectRatio,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: accent ? `${accentColor(accent, theme.colors)}44` : theme.colors.borderSubtle,
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          backgroundColor: theme.colors.surfaceInset,
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
  const theme = useAppTheme();
  const semantic = theme.semantic[tone];

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
  const theme = useAppTheme();
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
            borderWidth: motion.focused ? theme.state.focus.width : 1,
            borderColor: motion.focused ? theme.state.focus.color : theme.colors.borderStrong,
            backgroundColor: pressed ? theme.colors.pressed : theme.colors.surface,
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
  const theme = useAppTheme();
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
        backgroundColor: theme.colors.panelSoft,
      }}
    >
      {/* The initial is drawn whether or not there is a photo, and the photo
          covers it once it arrives. Rendered only in the photo's absence, a
          cold post page showed a blank disc where a face was about to be —
          HIG Images asks a placeholder to stand in while content loads. */}
      <Text style={{ color: theme.colors.text, fontSize: Math.max(10, Math.round(size * 0.44)), fontWeight: '800' }}>
        {initial}
      </Text>
      {uri ? (
        <Image
          source={{ uri }}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={uri}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : null}
    </View>
  );
}
