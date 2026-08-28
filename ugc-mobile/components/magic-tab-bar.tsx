import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Bell, Home, Plus, Users, User } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MagicCreateMenu } from '@/components/magic-create-menu';
import { getCreateMenuActionHref, type CreateMenuActionId } from '@/lib/create-menu-view-model';
import { haptic } from '@/lib/haptics';
import { useCrossFade, usePressMotion, useSpringState } from '@/lib/motion';
import { useTabBarBadge } from '@/lib/use-notification-badge';
import { resolvedBottomInset } from '@/lib/safe-area';
import { ADAPTIVE_INACTIVE_COLOR, useTabBarAmbientColor } from '@/lib/tab-bar-ambient';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';

const PRIMARY = appTheme.colors.primary ?? '#FF7A59';
const PRIMARY_STRONG = appTheme.colors.primaryStrong ?? '#FF8A6D';
const ON_PRIMARY = appTheme.colors.onPrimary ?? '#1A0E0A';
// Read with a fallback like the colours above: the focused tests mock the
// theme down to a couple of colours and have no motion block at all.
const CONTROL_PRESS_SCALE = appTheme.motion?.scale.pressedControl ?? 0.9;

// The glass branch drops the opaque panel fill on purpose — a near-solid
// background cancels the material outright.
//
// Legibility is handled by brightening the labels rather than by darkening the
// tint. Muted grey works on the solid bar because that bar is a known colour;
// under glass the backdrop is whatever post scrolled past, so the text has to
// carry itself. Darkening the tint instead would just walk back to a flat bar.
const GLASS_TINT = 'rgba(17,18,21,0.20)';
const GLASS_BORDER = 'rgba(255,255,255,0.16)';
// Liquid Glass adapts to its backdrop, but it adapts on brightness, not hue —
// a warm backdrop still arrives warm, which is why iOS drifted olive over skin
// tones exactly like Android did. So it gets the same cool lift, at roughly
// half strength: the material is already doing most of the work, and this
// branch has the least headroom before a wash starts milking it into a slab.
const GLASS_FROST_LIFT = 'rgba(236,240,255,0.07)';
const TRANSLUCENT_INACTIVE = 'rgba(255,255,255,0.88)';
// The adaptive fill is fully opaque: no pixels, text, or motion from behind the
// bar show through. What adapts is the colour, sampled from the band of the
// nearest card the dock actually sits over. `tab-bar-ambient.ts` owns both that
// sampling and the contrast cap that keeps this label and the coral active tint
// clear of the fill — which is why the label colour is defined over there.
const FALLBACK_BORDER = appTheme.colors.border ?? 'rgba(255,248,237,0.12)';
// Depth, and only depth. A fixed top-light/bottom-shade wash over the tint,
// held apart from the tint itself so the pill still reads as a raised surface
// without the gradient having any say in what colour the bar is.
const ADAPTIVE_SHADE: readonly [string, string] = ['rgba(255,255,255,0.05)', 'rgba(0,0,0,0.16)'];
// The create disc used to ring itself in opaque panel grey to separate it from
// the bar. Against a real material that ring reads as a hole punched through
// the glass, so it borrows the same rim light the surface uses.
const DISC_RIM = 'rgba(255,255,255,0.18)';
// Reduce Transparency gets a genuinely opaque bar. This is the one branch that
// should *not* thin out — those users asked for less see-through, not more.
const SOLID_FILL = '#111215';

// Same swap the create menu uses: the focused component tests mock react-native
// down to the primitives this file renders, so Animated.View is absent there.
const IS_TEST_ENVIRONMENT = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const AnimatedView = (IS_TEST_ENVIRONMENT ? View : Animated.View) as typeof Animated.View;

const VISIBLE_TABS = [
  { route: 'index', label: 'Home', Icon: Home },
  { route: 'showcase', label: 'Showcase', Icon: Users },
  { route: 'studio', label: 'Alerts', Icon: Bell },
  { route: 'profile', label: 'Profile', Icon: User },
] as const;

/**
 * Three surfaces, not two. Reduce Transparency and "no Liquid Glass" are
 * different needs: the normal fallback adapts its colour to the media, while
 * Reduce Transparency gets the deepest no-effect surface.
 *
 * `adaptive` is not the Android branch, despite being the one Android always
 * takes. It is selected by the absence of Liquid Glass, so every iOS device
 * below 26 lands here too — and should: an opaque dock tinted by the media is
 * the right answer wherever the material is unavailable, whatever the OS.
 */
export type TabBarSurfaceMode = 'glass' | 'adaptive' | 'solid';

function useTabBarSurfaceMode(): TabBarSurfaceMode {
  // Availability is fixed for the process (it depends on the OS and the SDK the
  // binary was built against), but reading it per mount rather than at module
  // scope keeps both branches reachable in tests without registry resets.
  const [available] = useState(isLiquidGlassAvailable);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // Read this regardless of glass support so the accessibility preference
    // remains authoritative on every platform.
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (active) setReduceTransparency(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  if (reduceTransparency) return 'solid';
  return available ? 'glass' : 'adaptive';
}

export function MagicTabBar({
  state,
  navigation,
  hidden = false,
}: BottomTabBarProps & { hidden?: boolean }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [createMenuVisible, setCreateMenuVisible] = useState(false);
  const createMotion = usePressMotion(false, { scale: CONTROL_PRESS_SCALE });
  const surfaceMode = useTabBarSurfaceMode();
  const pendingCreateAction = useRef<CreateMenuActionId | null>(null);
  const pendingActionFallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    // Unmounting mid-window (e.g. a root redirect) drops the pending action
    // on purpose — navigating after an unrelated redirect would fight it.
    if (pendingActionFallback.current) clearTimeout(pendingActionFallback.current);
  }, []);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const metrics = getMagicTabBarMetrics(width, bottomInset);
  // The Alerts tab is the only one with anything to announce; a badge on a tab
  // whose content has not changed is the dilution HIG warns about.
  const alertsBadge = useTabBarBadge();
  const activeRoute = state.routes[state.index]?.name;
  // Every tab, not just Home: the store is authoritative, and a surface with no
  // media to report hands the neutral dock back when it blurs.
  const fallbackFill = useTabBarAmbientColor();
  const { isCompact, centerSize, barHeight, centerGap, tabIconSize, tabLabelSize } = metrics;
  // Any translucent surface needs the text to carry itself; only the opaque
  // bar is a known enough backdrop for muted grey.
  const inactiveColor = surfaceMode === 'glass'
    ? TRANSLUCENT_INACTIVE
    : surfaceMode === 'adaptive'
      ? ADAPTIVE_INACTIVE_COLOR
      : appTheme.colors.muted;

  const navigateTo = (routeName: string) => {
    const event = navigation.emit({
      type: 'tabPress',
      target: state.routes.find((route) => route.name === routeName)?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  const navigateToCreateTab = () => {
    const createRoute = state.routes.find((route) => route.name === 'creator');
    const event = navigation.emit({
      type: 'tabPress',
      target: createRoute?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      const tabNavigation = navigation as typeof navigation & { jumpTo?: (name: string) => void };
      if (typeof tabNavigation.jumpTo === 'function') {
        tabNavigation.jumpTo('creator');
      } else {
        navigation.navigate('creator');
      }
    }
  };

  const completeCreateMenuAction = () => {
    if (pendingActionFallback.current) {
      clearTimeout(pendingActionFallback.current);
      pendingActionFallback.current = null;
    }

    const actionId = pendingCreateAction.current;
    if (!actionId) return;
    pendingCreateAction.current = null;

    if (actionId === 'create') {
      navigateToCreateTab();
      return;
    }

    router.push(getCreateMenuActionHref('post') as never);
  };

  const handleCreateMenuAction = (actionId: CreateMenuActionId) => {
    pendingCreateAction.current = actionId;
    setCreateMenuVisible(false);
    // Normally the menu's exit animation calls onExited, which delivers the
    // action. An interrupted animation (backgrounding, reduce-motion flip)
    // never completes, so back it up with a timer; delivery is idempotent.
    if (pendingActionFallback.current) clearTimeout(pendingActionFallback.current);
    pendingActionFallback.current = setTimeout(completeCreateMenuAction, 400);
  };

  return (
    <View
      // Hidden means invisible and inert, never unmounted: attaching the
      // Android BlurView mid tab-fade builds a cyclic RenderNode graph and
      // hwui overflows its stack computing transforms (SIGSEGV). Keeping the
      // bar mounted keeps the blur's target hookup stable across transitions,
      // so hide with opacity, not `display: 'none'` — display none detaches
      // the native view and reintroduces the same attach-during-fade window.
      pointerEvents={hidden ? 'none' : 'auto'}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: metrics.horizontalPadding,
        paddingBottom: metrics.bottomPadding,
        paddingTop: metrics.topPadding,
        opacity: hidden ? 0 : 1,
      }}
    >
      <MagicCreateMenu
        visible={createMenuVisible}
        onClose={() => setCreateMenuVisible(false)}
        onAction={handleCreateMenuAction}
        onExited={completeCreateMenuAction}
        horizontalInset={metrics.horizontalPadding}
        bottomInset={metrics.bottomPadding}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: metrics.bottomInset,
          backgroundColor: 'transparent',
        }}
      />
      <TabBarSurface mode={surfaceMode} barHeight={barHeight} fallbackFill={fallbackFill}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: isCompact ? 6 : 8, paddingVertical: isCompact ? 4 : 6 }}>
          <TabButton item={VISIBLE_TABS[0]} active={activeRoute === 'index'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('index')} />
          <TabButton item={VISIBLE_TABS[1]} active={activeRoute === 'showcase'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('showcase')} />
          <View style={{ width: centerGap, flexShrink: 0 }} />
          <TabButton item={VISIBLE_TABS[2]} active={activeRoute === 'studio'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} badge={alertsBadge} onPress={() => navigateTo('studio')} />
          <TabButton item={VISIBLE_TABS[3]} active={activeRoute === 'profile'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('profile')} />
        </View>
      </TabBarSurface>
      <AnimatedView
        style={[
          {
            position: 'absolute',
            top: 0,
            alignSelf: 'center',
            width: centerSize,
            height: centerSize,
            zIndex: 2,
          },
          createMotion.animatedStyle,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open create menu"
          accessibilityHint="Choose whether to create media or publish a post"
          accessibilityState={{ expanded: createMenuVisible }}
          onPress={() => {
            haptic.medium();
            setCreateMenuVisible(true);
          }}
          onPressIn={createMotion.onPressIn}
          onPressOut={createMotion.onPressOut}
          style={({ pressed }) => ({
            width: centerSize,
            height: centerSize,
            borderRadius: centerSize / 2,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            borderWidth: 1,
            borderColor: DISC_RIM,
            backgroundColor: pressed ? PRIMARY_STRONG : PRIMARY,
            elevation: 3,
            boxShadow: '0 6px 16px rgba(0,0,0,0.24)',
          })}
        >
          <Plus size={isCompact ? 23 : 25} color={ON_PRIMARY} />
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.4}
            style={{ color: ON_PRIMARY, fontSize: 11, lineHeight: 13, fontWeight: '800' }}
          >
            Create
          </Text>
        </Pressable>
      </AnimatedView>
    </View>
  );
}

/**
 * Tab bars: "a badge — a red oval containing white text and either a number or
 * an exclamation point". Pinned to the icon's top-right corner and out of the
 * layout flow, so a tab that gains a badge does not shift its neighbours.
 *
 * `maxFontSizeMultiplier` is 1 on purpose where the rest of the bar scales to
 * 1.4: the oval sizes itself off this text, and letting it grow pushes it over
 * the tab beside it. The count is repeated in the tab's accessibility label,
 * which is where a reader who needs larger type actually gets it.
 */
function TabBadge({ value, iconSize }: { value: string; iconSize: number }) {
  return (
    <View
      pointerEvents="none"
      // Announced through the tab's own label instead — a second focus stop
      // reading a bare number tells a VoiceOver user nothing.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        // Centred by the Pressable's `alignItems`, then walked right by half
        // the icon so the oval overlaps its top-right corner the way the
        // system's badge does.
        top: 4,
        marginLeft: iconSize,
        minWidth: 17,
        height: 17,
        paddingHorizontal: 4,
        borderRadius: 9,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: appTheme.colors.badge,
      }}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1}
        style={{ color: appTheme.colors.onBadge, fontSize: 11, lineHeight: 13, fontWeight: '800' }}
      >
        {value}
      </Text>
    </View>
  );
}

function TabBarSurface({
  mode,
  barHeight,
  fallbackFill,
  children,
}: {
  mode: TabBarSurfaceMode;
  barHeight: number;
  fallbackFill: string;
  children: ReactNode;
}) {
  const shape = {
    minHeight: barHeight,
    overflow: 'hidden' as const,
    borderRadius: barHeight / 2,
    borderCurve: 'continuous' as const,
    borderWidth: 1,
    boxShadow: '0 8px 24px rgba(0,0,0,0.24)',
  };

  if (mode === 'glass') {
    // No backgroundColor: the material is the surface. colorScheme is pinned
    // dark because app.json sets userInterfaceStyle dark — 'auto' would track
    // the system and light up the bar on a light-mode device.
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={GLASS_TINT}
        style={{ ...shape, borderColor: GLASS_BORDER }}
      >
        <FrostLift color={GLASS_FROST_LIFT} />
        {children}
      </GlassView>
    );
  }

  if (mode === 'solid') {
    return (
      <View style={{ ...shape, borderColor: appTheme.colors.border, backgroundColor: SOLID_FILL }}>
        {children}
      </View>
    );
  }

  return <AdaptiveSurface shape={shape} fill={fallbackFill}>{children}</AdaptiveSurface>;
}

/**
 * The adaptive dock. Two opaque tint layers cross-fading under one fixed shade.
 *
 * The colour is sampled per visible card, so it changes while a feed is being
 * scrolled. Swapping a `backgroundColor` outright made the bar flash between
 * fills; fading a second opaque layer in over the first animates on the native
 * thread and reads as the bar responding rather than as a repaint.
 *
 * The shade sits above both layers and never changes, which is what keeps the
 * gradient out of the colour decision: it is lighting, not tint. Its
 * predecessor was a five-stop horizontal ramp with a hard dark stop at 0.52,
 * landing a shadow directly under the raised Create button.
 */
function AdaptiveSurface({
  shape,
  fill,
  children,
}: {
  shape: ViewStyle;
  fill: string;
  children: ReactNode;
}) {
  const { from, to, progress } = useCrossFade(fill);

  return (
    <View testID="tab-bar-adaptive-surface" style={{ ...shape, borderColor: FALLBACK_BORDER, backgroundColor: from }}>
      <AnimatedView
        pointerEvents="none"
        testID="tab-bar-adaptive-fill"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: to,
          opacity: progress ?? 1,
        }}
      />
      <LinearGradient
        testID="tab-bar-adaptive-shade"
        pointerEvents="none"
        colors={ADAPTIVE_SHADE}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {children}
    </View>
  );
}

/**
 * A faint cool lift for Liquid Glass only. The adaptive fallback carries its own
 * shade inside `AdaptiveSurface` and takes no decorative overlay on top of it.
 */
function FrostLift({ color }: { color: string }) {
  return (
    <View
      testID="tab-bar-frost-lift"
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color }}
    />
  );
}

function TabButton({
  item,
  active,
  iconSize,
  labelSize,
  inactiveColor,
  badge = null,
  onPress,
}: {
  item: (typeof VISIBLE_TABS)[number];
  active: boolean;
  iconSize: number;
  labelSize: number;
  inactiveColor: string;
  /** Pre-formatted by `formatBadgeCount`; null draws nothing. */
  badge?: string | null;
  onPress: () => void;
}) {
  const Icon = item.Icon;
  const color = active ? PRIMARY : inactiveColor;
  const progress = useSpringState(active);
  const press = usePressMotion(false, { scale: CONTROL_PRESS_SCALE });
  const iconScale = progress?.interpolate({
    inputRange: [0, 1],
    outputRange: [1, appTheme.motion.scale.selected],
  });

  return (
    <Pressable
      accessibilityRole="tab"
      // The oval is a visual-only signal unless the label says it too: a
      // VoiceOver user hears "Alerts" and learns nothing about the badge.
      accessibilityLabel={badge ? `${item.label}, ${badge} unread` : item.label}
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={({ pressed }) => ({
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: 52,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
        borderCurve: 'continuous',
        // Selection lives in the icon and label, matching the iOS reference.
        // An extra indicator or coral pill makes this small dock feel busier.
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : 'transparent',
      })}
    >
      {/* A sibling of the content column, not a child of the scaled icon
          wrapper: inside it the badge grew with the selected-state spring, and
          its percentage offset resolved against the whole tab slot rather than
          the 22pt icon, which parked the oval between two tabs. */}
      {badge ? <TabBadge value={badge} iconSize={iconSize} /> : null}
      <AnimatedView style={[{ alignItems: 'center', gap: 3 }, press.animatedStyle]}>
        <AnimatedView style={{ transform: [{ scale: iconScale ?? 1 }] }}>
          <Icon size={iconSize} color={color} />
        </AnimatedView>
        {/* Capped scaling: the bar is a fixed-height row of five slots around a
            raised centre button, so unbounded Dynamic Type ran the labels into
            it. They still grow for legibility, just not past what the slot can
            hold — the icon above carries the meaning at extreme sizes. */}
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.76}
          maxFontSizeMultiplier={1.4}
          style={{ color, fontSize: labelSize, fontWeight: active ? '700' : '500' }}
        >
          {item.label}
        </Text>
      </AnimatedView>
    </Pressable>
  );
}
