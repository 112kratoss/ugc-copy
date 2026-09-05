import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Bell, Compass, Home, Plus, User } from 'lucide-react-native';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
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
import { useCrossFade, usePressMotion, useReducedMotion, useSpringState } from '@/lib/motion';
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
const ANDROID_PRESS_SCALE = 0.96;
// Bounded by the "Create" label sitting under it inside the dock, which the iOS
// disc does not have to clear (that one carries its own label). The control
// grows downward from a fixed top while the label is bottom-aligned in the row,
// so the dock's height sets the ceiling: a 58pt row puts the label's top edge
// at 65pt from the container's top, leaving 60 as the largest size with air to
// spare. That holds the control at ~0.88 of the dock's height.
const ANDROID_CREATE_SIZE = 58;
const ANDROID_CREATE_COMPACT_SIZE = 52;

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
  { route: 'showcase', label: 'Explore', Icon: Compass },
  { route: 'studio', label: 'Alerts', Icon: Bell },
  { route: 'profile', label: 'Profile', Icon: User },
] as const;

/**
 * Three surfaces, not two. Reduce Transparency and "no Liquid Glass" are
 * different needs: the normal fallback adapts its colour to the media, while
 * Reduce Transparency gets the deepest no-effect surface.
 *
 * iOS falls back to `adaptive` when Liquid Glass is unavailable. Android has
 * its own opaque navigation dock, independent of these iOS surface modes.
 */
export type TabBarSurfaceMode = 'glass' | 'adaptive' | 'solid';

function useTabBarSurfaceMode(): TabBarSurfaceMode {
  // Availability is fixed for the process (it depends on the OS and the SDK the
  // binary was built against), but reading it per mount rather than at module
  // scope keeps both branches reachable in tests without registry resets.
  const [available] = useState(isLiquidGlassAvailable);
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    // Android renders its own opaque dock and never consults this mode, so the
    // preference is read on the platforms whose surfaces answer to it. Reading
    // it regardless of *glass support* still matters: an iOS device without
    // Liquid Glass has to honour Reduce Transparency too.
    if (Platform.OS === 'android') return;

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
      {Platform.OS === 'android' ? (
        <AndroidNavigationDock
          activeRoute={activeRoute}
          alertsBadge={alertsBadge}
          isCompact={isCompact}
          menuVisible={createMenuVisible}
          onNavigate={navigateTo}
          onCreate={() => {
            haptic.medium();
            setCreateMenuVisible(true);
          }}
        />
      ) : <>
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
      </>}
    </View>
  );
}

/** Adjacent destinations glide; crossing Create fades between fixed capsules. */
function useAndroidTabSelection(activeSlot: number, reducedMotion: boolean) {
  const previousSlot = useRef(activeSlot);
  const [motion] = useState(() => IS_TEST_ENVIRONMENT ? null : {
    position: new Animated.Value(Math.max(0, activeSlot)),
    opacity: new Animated.Value(activeSlot >= 0 ? 1 : 0),
    outgoingPosition: new Animated.Value(Math.max(0, activeSlot)),
    outgoingOpacity: new Animated.Value(0),
  });

  useEffect(() => {
    if (!motion) return;
    const from = previousSlot.current;
    previousSlot.current = activeSlot;
    const stop = () => {
      motion.position.stopAnimation();
      motion.opacity.stopAnimation();
      motion.outgoingOpacity.stopAnimation();
    };
    stop();
    motion.outgoingOpacity.setValue(0);

    if (activeSlot < 0) {
      motion.opacity.setValue(0);
      return stop;
    }
    if (reducedMotion || from < 0 || from === activeSlot) {
      motion.position.setValue(activeSlot);
      motion.opacity.setValue(1);
      return stop;
    }

    const crossesCreate = (from < 2) !== (activeSlot < 2);
    if (crossesCreate) {
      // There are no completion callbacks: a new tap can safely interrupt
      // either fade without an old animation moving the selection back.
      motion.outgoingPosition.setValue(from);
      motion.outgoingOpacity.setValue(1);
      motion.opacity.setValue(0);
      motion.position.setValue(activeSlot);
      Animated.parallel([
        Animated.timing(motion.outgoingOpacity, { toValue: 0, duration: appTheme.motion.duration.navigation, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(motion.opacity, { toValue: 1, duration: appTheme.motion.duration.navigation, easing: Easing.linear, useNativeDriver: true }),
      ]).start();
    } else {
      motion.opacity.setValue(1);
      Animated.spring(motion.position, {
        toValue: activeSlot,
        ...appTheme.motion.spring.panel,
        useNativeDriver: true,
      }).start();
    }
    return stop;
  }, [activeSlot, motion, reducedMotion]);

  return motion;
}

/** Finger-driven elastic feedback: anchored swell, capsule stretch, soft settle. */
function useAndroidDockPop(reducedMotion: boolean) {
  const [progress] = useState(() => IS_TEST_ENVIRONMENT ? null : new Animated.Value(0));
  const animation = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    animation.current?.stop();
    progress?.setValue(0);
    return () => { animation.current?.stop(); };
  }, [progress, reducedMotion]);

  const animate = (pressed: boolean) => {
    if (!progress) return;
    animation.current?.stop();
    if (reducedMotion) {
      progress.setValue(0);
      return;
    }
    // A short tap still reaches the swell; a held press remains expanded until
    // release. Interruptions start at the current value without accumulating.
    animation.current = pressed
      ? Animated.spring(progress, {
          toValue: 1,
          ...appTheme.motion.spring.pressIn,
          useNativeDriver: true,
        })
      : Animated.sequence([
          Animated.timing(progress, {
            toValue: 1,
            duration: appTheme.motion.duration.navigationSwell,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.spring(progress, {
            toValue: 0,
            ...appTheme.motion.spring.navigationSettle,
            useNativeDriver: true,
          }),
        ]);
    animation.current.start();
  };

  return {
    onPressIn: () => animate(true),
    onPressOut: () => animate(false),
    capsuleScale: progress?.interpolate({ inputRange: [0, 1], outputRange: [1, appTheme.motion.scale.navigationCapsule] }) ?? 1,
    style: progress ? {
      transform: [
        { scaleX: progress.interpolate({ inputRange: [0, 1], outputRange: [1, appTheme.motion.scale.navigationSwellX] }) },
        { scaleY: progress.interpolate({ inputRange: [0, 1], outputRange: [1, appTheme.motion.scale.navigationSwellY] }) },
      ],
    } : undefined,
  };
}

/** A graphite dock with inset selection capsules and a central creation action. */
function AndroidNavigationDock({
  activeRoute,
  alertsBadge,
  isCompact,
  menuVisible,
  onNavigate,
  onCreate,
}: {
  activeRoute: string | undefined;
  alertsBadge: string | null;
  isCompact: boolean;
  menuVisible: boolean;
  onNavigate: (route: string) => void;
  onCreate: () => void;
}) {
  const press = usePressMotion(false, { scale: ANDROID_PRESS_SCALE });
  const createMotion = usePressMotion(false, { scale: CONTROL_PRESS_SCALE });
  const createSize = isCompact ? ANDROID_CREATE_COMPACT_SIZE : ANDROID_CREATE_SIZE;
  const reducedMotion = useReducedMotion();
  const dockPop = useAndroidDockPop(reducedMotion);
  const [trackWidth, setTrackWidth] = useState(0);
  const activeIndex = VISIBLE_TABS.findIndex((item) => item.route === activeRoute);
  // The middle slot belongs to Create, so Alerts and Profile sit one slot farther right.
  const activeSlot = activeIndex >= 2 ? activeIndex + 1 : activeIndex;
  const selection = useAndroidTabSelection(activeSlot, reducedMotion);
  const slotWidth = trackWidth / (VISIBLE_TABS.length + 1);
  const indicatorWidth = Math.max(0, slotWidth);
  const indicatorStyle = {
    position: 'absolute' as const,
    top: 0,
    bottom: 0,
    left: 0,
    width: indicatorWidth,
    borderRadius: appTheme.radii.pill,
    backgroundColor: appTheme.colors.navigationSelected,
  };
  const indicatorTranslation = (value: Animated.Value | undefined, fallbackSlot: number) => (
    value?.interpolate({ inputRange: [0, 4], outputRange: [0, slotWidth * 4] })
    ?? Math.max(0, fallbackSlot) * slotWidth
  );

  const renderTab = (item: (typeof VISIBLE_TABS)[number]) => (
    <TabButton
      key={item.route}
      item={item}
      active={activeRoute === item.route}
      iconSize={20}
      labelSize={11}
      inactiveColor={appTheme.colors.muted}
      badge={item.route === 'studio' ? alertsBadge : null}
      onPress={() => onNavigate(item.route)}
      onDockPressIn={dockPop.onPressIn}
      onDockPressOut={dockPop.onPressOut}
      android
    />
  );

  return (
    <>
    <AnimatedView
      testID="android-navigation-dock"
      style={[{
        width: '100%',
        maxWidth: 480,
        alignSelf: 'center',
        padding: 8,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: appTheme.colors.borderSubtle,
        borderTopColor: appTheme.colors.border,
        backgroundColor: appTheme.colors.panel,
        ...appTheme.shadow?.navigation,
      }, dockPop.style]}
    >
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.025)', 'rgba(0,0,0,0.08)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: appTheme.radii.pill }}
      />
      <View
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        style={{ flexDirection: 'row', alignItems: 'center' }}
      >
        {slotWidth > 0 && activeIndex >= 0 ? <>
          <AnimatedView
            testID="android-tab-selection-outgoing"
            pointerEvents="none"
            style={[
              indicatorStyle,
              { opacity: selection?.outgoingOpacity ?? 0,
                transform: [{ translateX: indicatorTranslation(selection?.outgoingPosition, activeSlot) }] },
            ]}
          />
          <AnimatedView
            testID="android-tab-selection"
            pointerEvents="none"
            style={[
              indicatorStyle,
              { opacity: selection?.opacity ?? 1,
                transform: [{ translateX: indicatorTranslation(selection?.position, activeSlot) }, { scaleX: dockPop.capsuleScale }] },
            ]}
          />
        </> : null}
        {VISIBLE_TABS.slice(0, 2).map(renderTab)}
        {/* Only the label lives in the row; the control itself is raised out of
            the dock below. Inert and unannounced on purpose — the raised button
            is the one accessible target, so a screen reader hears one Create,
            not two. Bottom-aligned to land on the same baseline as the four
            labels beside it. */}
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={{ flex: 1, minHeight: 50, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 4 }}
        >
          <Text numberOfLines={1} maxFontSizeMultiplier={1.4}
            style={{ color: appTheme.colors.text, fontSize: 11, lineHeight: 14, fontWeight: '700' }}>
            Create
          </Text>
        </View>
        {VISIBLE_TABS.slice(2).map(renderTab)}
      </View>
    </AnimatedView>

    {/* Positioned exactly as the iOS disc is: absolute, `top: 0` inside the
        container whose `paddingTop` reserves the overhang, so the control sits
        in that strip and overlaps the dock. Keeping it inside those bounds is
        what makes the part above the dock tappable — Android does not deliver
        touches to a child drawn outside its parent. */}
    <AnimatedView
      style={[
        { position: 'absolute', top: 0, alignSelf: 'center', width: createSize, height: createSize, zIndex: 2 },
        createMotion.animatedStyle,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open create menu"
        accessibilityHint="Choose whether to create media or publish a post"
        accessibilityState={{ expanded: menuVisible }}
        onPress={onCreate}
        onPressIn={createMotion.onPressIn}
        onPressOut={createMotion.onPressOut}
        style={{
          flex: 1,
          borderRadius: createSize / 2,
          borderWidth: 1,
          borderColor: DISC_RIM,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          elevation: 6,
          ...appTheme.shadow?.navigationCreate,
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={[appTheme.colors.navigationCreateTop ?? PRIMARY_STRONG, appTheme.colors.navigationCreateBottom ?? PRIMARY]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <Plus size={appTheme.icon.feature} color="#ffffff" />
      </Pressable>
    </AnimatedView>
    </>
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
  android = false,
  onDockPressIn,
  onDockPressOut,
}: {
  item: { route: string; label: string; Icon: typeof Home };
  active: boolean;
  iconSize: number;
  labelSize: number;
  inactiveColor: string;
  /** Pre-formatted by `formatBadgeCount`; null draws nothing. */
  badge?: string | null;
  onPress: () => void;
  android?: boolean;
  onDockPressIn?: () => void;
  onDockPressOut?: () => void;
}) {
  const Icon = item.Icon;
  const color = active ? PRIMARY : inactiveColor;
  const progress = useSpringState(active);
  const press = usePressMotion(false, { scale: android ? ANDROID_PRESS_SCALE : CONTROL_PRESS_SCALE });
  const iconScale = progress?.interpolate({
    inputRange: [0, 1],
    outputRange: [1, android ? 1 : appTheme.motion.scale.selected],
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
      onPressIn={() => { if (android) onDockPressIn?.(); else press.onPressIn(); }}
      onPressOut={() => { if (android) onDockPressOut?.(); else press.onPressOut(); }}
      style={({ pressed }) => ({
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: android ? 50 : 52,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: android ? 25 : 18,
        borderCurve: 'continuous',
        // The Android content presses as one unit inside the selection capsule.
        backgroundColor: pressed && !android ? appTheme.colors.surfaceStrong : 'transparent',
      })}
    >
      {/* A sibling of the content column, not a child of the scaled icon
          wrapper: inside it the badge grew with the selected-state spring, and
          its percentage offset resolved against the whole tab slot rather than
          the 22pt icon, which parked the oval between two tabs. */}
      {badge ? <TabBadge value={badge} iconSize={iconSize} /> : null}
      <AnimatedView style={[{ alignItems: 'center', gap: android ? 2 : 3, ...(android ? { width: '100%' as const, paddingVertical: 4 } : {}) }, press.animatedStyle]}>
        <AnimatedView style={{
          ...(android ? { width: 40, height: 26, alignItems: 'center', justifyContent: 'center' } as const : {}),
          transform: [{ scale: iconScale ?? 1 }],
        }}>
          <AnimatedView>
            <Icon size={iconSize} color={color} fill={android && active ? appTheme.colors.navigationIconFill : 'none'} fillOpacity={0.45} />
          </AnimatedView>
        </AnimatedView>
        {/* Capped scaling: the bar is a fixed-height row of five slots around a
            raised centre button, so unbounded Dynamic Type ran the labels into
            it. They still grow for legibility, just not past what the slot can
            hold — the icon above carries the meaning at extreme sizes. */}
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit={!android}
          minimumFontScale={android ? 1 : 0.76}
          maxFontSizeMultiplier={1.4}
          style={{ color, fontSize: labelSize, ...(android ? { lineHeight: 14 } : {}), fontWeight: android ? '600' : active ? '700' : '500' }}
        >
          {item.label}
        </Text>
      </AnimatedView>
    </Pressable>
  );
}
