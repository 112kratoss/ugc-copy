import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { RefObject } from 'react';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { router } from 'expo-router';
import { Bell, Home, Plus, Users, User } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MagicCreateMenu } from '@/components/magic-create-menu';
import { getCreateMenuActionHref, type CreateMenuActionId } from '@/lib/create-menu-view-model';
import { useSpringState } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';

const PRIMARY = appTheme.colors.primary ?? '#FF7A59';
const PRIMARY_STRONG = appTheme.colors.primaryStrong ?? '#FF8A6D';
const PRIMARY_PRESSED = appTheme.colors.pressed ?? 'rgba(255,122,89,0.13)';
const ON_PRIMARY = appTheme.colors.onPrimary ?? '#1A0E0A';

// The glass branch drops the opaque panel fill on purpose — a near-solid
// background cancels the material outright.
//
// Legibility is handled by brightening the labels rather than by darkening the
// tint. Muted grey works on the solid bar because that bar is a known colour;
// under glass the backdrop is whatever post scrolled past, so the text has to
// carry itself. Darkening the tint instead would just walk back to a flat bar.
const GLASS_TINT = 'rgba(17,18,21,0.20)';
const GLASS_BORDER = 'rgba(255,255,255,0.16)';
const TRANSLUCENT_INACTIVE = 'rgba(255,255,255,0.90)';
// Android's blur is softer than the iOS material, so it carries a heavier tint
// than GLASS_TINT while still letting the backdrop through.
const BLUR_TINT = 'rgba(17,18,21,0.60)';
// Held at 16 for years because the opaque fill made it invisible; a real blur
// needs real intensity. Raising this quiets a busy backdrop without making the
// bar more opaque, which is the trade a heavier tint alone would force.
const BLUR_INTENSITY = 55;
// Reduce Transparency gets a genuinely opaque bar. This is the one branch that
// should *not* thin out — those users asked for less see-through, not more.
const SOLID_FILL = 'rgba(17,18,21,0.96)';

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
 * different needs that used to share one fallback: Android wants a real blur
 * with a thin tint, while Reduce Transparency wants an opaque bar. Collapsing
 * them means either Android stays flat or accessibility regresses.
 */
export type TabBarSurfaceMode = 'glass' | 'blur' | 'solid';

function useTabBarSurfaceMode(): TabBarSurfaceMode {
  // Availability is fixed for the process (it depends on the OS and the SDK the
  // binary was built against), but reading it per mount rather than at module
  // scope keeps both branches reachable in tests without registry resets.
  const [available] = useState(isLiquidGlassAvailable);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // Read this regardless of glass support: the blur surface is translucent
    // too, so an Android user with Reduce Transparency on must reach the opaque
    // branch just like an iOS one does.
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
  return available ? 'glass' : 'blur';
}

export function MagicTabBar({
  state,
  navigation,
  blurTarget,
}: BottomTabBarProps & { blurTarget?: RefObject<View | null> }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [createMenuVisible, setCreateMenuVisible] = useState(false);
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
  const activeRoute = state.routes[state.index]?.name;
  const { isCompact, centerSize, barHeight, centerGap, tabIconSize, tabLabelSize } = metrics;
  // Any translucent surface needs the text to carry itself; only the opaque
  // bar is a known enough backdrop for muted grey.
  const inactiveColor = surfaceMode === 'solid' ? appTheme.colors.muted : TRANSLUCENT_INACTIVE;

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
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: metrics.horizontalPadding,
        paddingBottom: metrics.bottomPadding,
        paddingTop: metrics.topPadding,
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
      <TabBarSurface mode={surfaceMode} barHeight={barHeight} blurTarget={blurTarget}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: isCompact ? 6 : 8, paddingVertical: isCompact ? 4 : 6 }}>
          <TabButton item={VISIBLE_TABS[0]} active={activeRoute === 'index'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('index')} />
          <TabButton item={VISIBLE_TABS[1]} active={activeRoute === 'showcase'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('showcase')} />
          <View style={{ width: centerGap, flexShrink: 0 }} />
          <TabButton item={VISIBLE_TABS[2]} active={activeRoute === 'studio'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('studio')} />
          <TabButton item={VISIBLE_TABS[3]} active={activeRoute === 'profile'} iconSize={tabIconSize} labelSize={tabLabelSize} inactiveColor={inactiveColor} onPress={() => navigateTo('profile')} />
        </View>
      </TabBarSurface>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open create menu"
        accessibilityHint="Choose whether to create media or publish a post"
        accessibilityState={{ expanded: createMenuVisible }}
        onPress={() => setCreateMenuVisible(true)}
        style={({ pressed }) => ({
          position: 'absolute',
          top: 0,
          alignSelf: 'center',
          width: centerSize,
          height: centerSize,
          borderRadius: centerSize / 2,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          borderWidth: 2,
          borderColor: appTheme.colors.panel,
          backgroundColor: pressed ? PRIMARY_STRONG : PRIMARY,
          opacity: pressed ? 0.85 : 1,
          zIndex: 2,
          elevation: 5,
          boxShadow: '0 8px 20px rgba(0,0,0,0.36)',
        })}
      >
        <Plus size={isCompact ? 23 : 25} color={ON_PRIMARY} strokeWidth={2.7} />
        <Text style={{ color: ON_PRIMARY, fontSize: 9, lineHeight: 11, fontWeight: '800' }}>Create</Text>
      </Pressable>
    </View>
  );
}

function TabBarSurface({
  mode,
  barHeight,
  blurTarget,
  children,
}: {
  mode: TabBarSurfaceMode;
  barHeight: number;
  blurTarget?: RefObject<View | null>;
  children: ReactNode;
}) {
  const shape = {
    minHeight: barHeight,
    overflow: 'hidden' as const,
    borderRadius: barHeight / 2,
    borderCurve: 'continuous' as const,
    borderWidth: 1,
    boxShadow: '0 12px 30px rgba(0,0,0,0.34)',
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

  return (
    <BlurView
      intensity={BLUR_INTENSITY}
      tint="dark"
      // Android renders nothing without a target to sample, and only gets a real
      // GPU blur from SDK 31+; below that the method degrades to a plain
      // semi-transparent view rather than burning RenderScript on old hardware.
      blurMethod="dimezisBlurViewSdk31Plus"
      blurTarget={blurTarget}
      style={{ ...shape, borderColor: GLASS_BORDER, backgroundColor: BLUR_TINT }}
    >
      {children}
    </BlurView>
  );
}

function TabButton({
  item,
  active,
  iconSize,
  labelSize,
  inactiveColor,
  onPress,
}: {
  item: (typeof VISIBLE_TABS)[number];
  active: boolean;
  iconSize: number;
  labelSize: number;
  inactiveColor: string;
  onPress: () => void;
}) {
  const Icon = item.Icon;
  const color = active ? PRIMARY : inactiveColor;
  const progress = useSpringState(active);
  // `progress` is null under test, where AnimatedView is a plain View; fall back
  // to the settled value so the rendered tree still reflects the active state.
  const settled = active ? 1 : 0;
  const iconScale = progress?.interpolate({
    inputRange: [0, 1],
    outputRange: [1, appTheme.motion.scale.selected],
  });

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: 52,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: 18,
        borderCurve: 'continuous',
        backgroundColor: active ? PRIMARY_PRESSED : pressed ? appTheme.colors.surfaceStrong : 'transparent',
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <AnimatedView
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 2,
          width: 18,
          height: 3,
          borderRadius: 2,
          backgroundColor: PRIMARY,
          // Always mounted so the spring has something to drive; scaleX grows it
          // out of the centre rather than animating width, which the native
          // driver cannot handle.
          opacity: progress ?? settled,
          transform: [{ scaleX: progress ?? settled }],
        }}
      />
      <AnimatedView style={{ transform: [{ scale: iconScale ?? 1 }] }}>
        <Icon size={iconSize} color={color} strokeWidth={active ? 2.5 : 2.1} />
      </AnimatedView>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.76} style={{ color, fontSize: labelSize, fontWeight: active ? '800' : '600' }}>{item.label}</Text>
    </Pressable>
  );
}
