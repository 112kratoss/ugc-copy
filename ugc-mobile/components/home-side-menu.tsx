import type { User } from '@supabase/supabase-js';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
  BadgeCheck,
  ChevronRight,
  CircleHelp,
  Crown,
  Gift,
  Layers3,
  LayoutDashboard,
  LogIn,
  LogOut,
  PackageOpen,
  Settings,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  Animated,
  BackHandler,
  Modal,
  PanResponder,
  type ModalProps,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SHEET_DISMISS_DISTANCE, SHEET_DISMISS_VELOCITY } from '@/components/sheet-chrome';
import { BrandLockup } from '@/components/ui';
import { showMessageDialog } from '@/lib/dialog';
import { useReducedMotion } from '@/lib/motion';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { formatUsdCents } from '@/lib/home-view-model';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { formatCreditAmount } from '@/lib/pricing';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import type { ProfileResponse } from '@/lib/types';

/** Below this the drag is still ambiguous with a tap or a vertical scroll. */
const DRAWER_DRAG_CLAIM_DISTANCE = 8;
// Keeps the panel's drop shadow past the screen edge while it is closed.
const DRAWER_HIDDEN_SLOP = 64;
const IS_TEST_ENVIRONMENT = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const FallbackModal = ({ children, visible }: ModalProps) => (
  visible ? <>{children}</> : null
);
const AnimatedView = (IS_TEST_ENVIRONMENT ? View : Animated.View) as typeof Animated.View;
const ModalSurface: React.ComponentType<ModalProps> = IS_TEST_ENVIRONMENT ? FallbackModal : Modal;

interface HomeSideMenuProps {
  visible: boolean;
  onClose: () => void;
  user: User | null;
  profile: ProfileResponse | null | undefined;
  credits: number;
  totalSalesUsdCents: number;
  totalSalesLoading: boolean;
  onSignOut: () => Promise<void>;
}

export function HomeSideMenu({
  visible,
  onClose,
  user,
  profile,
  credits,
  totalSalesUsdCents,
  totalSalesLoading,
  onSignOut,
}: HomeSideMenuProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const drawerWidth = Math.min(Math.max(width * 0.84, 280), 360, Math.max(0, width - 48));
  const displayName =
    profile?.displayName?.trim() ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Guest creator';
  const handle = profile?.username?.trim()
    ? `@${profile.username}`
    : user?.email ?? 'Sign in to save and sync your work';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'A';
  const reduceMotionEnabled = useReducedMotion();
  const [rendered, setRendered] = useState(visible);
  const progress = useRef(createAnimatedValue(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setRendered(true);
  }, [visible]);

  useEffect(() => {
    if (!rendered) return;

    animateProgress(progress, visible ? 1 : 0, reduceMotionEnabled, () => {
      if (!visible) setRendered(false);
    });
  }, [progress, reduceMotionEnabled, rendered, visible]);

  useEffect(() => {
    if (IS_TEST_ENVIRONMENT || !visible || !BackHandler.addEventListener) return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });

    return () => subscription.remove();
  }, [onClose, visible]);

  const navigateAndClose = (path: string) => {
    onClose();
    router.push(path as never);
  };

  const handleAuthPress = async () => {
    // The menu steps aside either way. For a sign-out, the app-wide cover in
    // components/sign-out-overlay.tsx shows the progress; it draws in the app's
    // own window, which this menu's Modal would otherwise sit on top of.
    onClose();
    if (user) {
      try {
        await onSignOut();
      } catch {
        showMessageDialog({ title: 'Could not sign out', message: 'Please try again.' });
      }
      return;
    }
    router.push('/auth' as never);
  };

  // Revealed by dragging in from the left edge, so it closes by dragging back
  // to it. Motion: "Strive for realistic feedback motion that follows people's
  // gestures and expectations … if someone reveals a view by sliding it down
  // from the top, they don't expect to dismiss the view by sliding it to the
  // side." Tapping the backdrop or Close still works; this is the shortcut.
  //
  // Claimed in the capture phase, and only for a drag that is dominantly
  // leftward: the drawer's body is a ScrollView that would otherwise own every
  // move, and capture is what lets the parent take a horizontal drag back from
  // it without touching vertical scrolling or taps.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A brand-new offset for every opening, the way `useSheetDismissDrag` does
  // it, rather than one value reset in place. Once the native driver has
  // touched an `Animated.Value` it carries history across the panel's unmount
  // — a dropped native node, a read-back of its last native value scheduled at
  // detach, a JS mirror that read-back overwrites later — and a `setValue(0)`
  // on it while nothing is attached trusts the order those land in. The sheets
  // reopened one drag-offset too low about one time in five that way.
  const [opening, setOpening] = useState(() => ({ visible, dragX: createAnimatedValue(0) }));
  if (opening.visible !== visible) {
    setOpening({ visible, dragX: visible ? createAnimatedValue(0) : opening.dragX });
  }
  const dragX = opening.dragX;

  const closeDrag = useMemo(() => PanResponder?.create?.({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => (
      gesture.dx < -DRAWER_DRAG_CLAIM_DISTANCE && Math.abs(gesture.dx) > Math.abs(gesture.dy)
    ),
    onPanResponderMove: (_event, gesture) => {
      dragX?.setValue(Math.min(0, gesture.dx));
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.vx < -SHEET_DISMISS_VELOCITY || gesture.dx < -SHEET_DISMISS_DISTANCE) {
        onCloseRef.current();
        return;
      }
      if (dragX && Animated?.spring) {
        // Same surface, same spring as the entrance. These were the literals
        // 190/13 — numerically the theme's tension/friction, copied by hand,
        // so they looked correct while tracking nothing.
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true, ...appTheme.motion.spring.panel }).start();
      } else {
        dragX?.setValue(0);
      }
    },
    onPanResponderTerminate: () => {
      dragX?.setValue(0);
    },
  }), [dragX]);

  const backdropOpacity = progress
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.64 * theme.dim.scale] })
    : 0.64;
  // No opacity ramp on the panel itself. The old 0.86 -> 1 fade existed to
  // paper over a drawer that barely moved; a surface that slides in from the
  // edge should not also dissolve into place. The backdrop still fades.
  const entryTranslateX = progress
    ? progress.interpolate({
        inputRange: [0, 1],
        // Its own width plus slop for the shadow. The panel casts
        // `16px 0 40px`, so parking it at exactly -drawerWidth would leave
        // roughly 56pt of shadow spilling across the closed screen.
        outputRange: [-(drawerWidth + DRAWER_HIDDEN_SLOP), 0],
      })
    : 0;
  // Folded into one transform entry rather than stacked: a JS-driven value
  // beside a native-driven one on the same view does not compose.
  const drawerTranslateX = progress && dragX
    ? Animated.add(entryTranslateX, dragX)
    : entryTranslateX;

  return (
    <ModalSurface
      visible={rendered}
      transparent
      animationType="none"
      presentationStyle="overFullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1, flexDirection: 'row' }}>
        <AnimatedView
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: theme.dim.color,
            opacity: backdropOpacity,
          }}
        >
          <Pressable accessible={false} onPress={onClose} style={{ flex: 1 }} />
        </AnimatedView>

        <AnimatedView
          {...(closeDrag?.panHandlers ?? {})}
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={{
            width: drawerWidth,
            borderRightWidth: 1,
            borderRightColor: theme.colors.border,
            backgroundColor: theme.colors.background,
            transform: [{ translateX: drawerTranslateX }],
            boxShadow: theme.shadow.drawer.boxShadow,
          }}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              flexGrow: 1,
              gap: 16,
              paddingTop: topInset + 12,
              paddingBottom: bottomInset + 16,
              paddingHorizontal: 16,
            }}
          >
            <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <BrandLockup />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close menu"
                onPress={onClose}
                hitSlop={4}
                style={({ pressed }) => ({
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surface,
                  opacity: pressed ? appTheme.opacity.pressed : 1,
                })}
              >
                <CloseGlyph size={appTheme.icon.feature} color={theme.colors.text} />
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={user ? `Open profile for ${displayName}` : 'Open profile and sign-in options'}
              onPress={() => navigateAndClose('/profile')}
              style={({ pressed }) => ({
                minHeight: 88,
                borderRadius: 20,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: pressed ? theme.colors.primaryStrong : theme.colors.border,
                padding: 14,
                backgroundColor: pressed ? theme.colors.pressed : theme.colors.panel,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 27,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: theme.colors.primaryStrong,
                    backgroundColor: theme.colors.pressed,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {profile?.avatarUrl ? (
                    <Image source={{ uri: profile.avatarUrl }} contentFit="cover" style={{ position: 'absolute', inset: 0 }} />
                  ) : (
                    <Text style={{ color: theme.colors.primary, fontSize: 21, fontWeight: '800' }}>{initial}</Text>
                  )}
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 17, lineHeight: 22, fontWeight: '800', flexShrink: 1 }}>
                      {displayName}
                    </Text>
                    {user ? <BadgeCheck size={17} color={theme.colors.primary} /> : null}
                  </View>
                  <Text
                    numberOfLines={user ? 1 : 2}
                    style={{ color: theme.colors.muted, fontSize: 13, lineHeight: 18, fontWeight: '600' }}
                  >
                    {handle}
                  </Text>
                </View>
                <ChevronRight size={19} color={theme.colors.muted} />
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${formatCreditAmount(credits)} credits. Open credits`}
              onPress={() => navigateAndClose('/pricing')}
              style={({ pressed }) => ({
                minHeight: 68,
                borderRadius: 20,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: pressed ? hexWithAlpha(theme.colors.amber, 0.34) : theme.colors.border,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                backgroundColor: pressed ? hexWithAlpha(theme.colors.amber, 0.08) : theme.colors.panel,
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(theme.colors.amber, 0.12) }}>
                  <Crown size={21} color={theme.colors.amber} />
                </View>
                <View style={{ gap: 1, minWidth: 0, flex: 1 }}>
                  <Text style={{ color: theme.colors.text, fontSize: 18, lineHeight: 23, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatCreditAmount(credits)} Credits</Text>
                  <Text style={{ color: theme.colors.muted, fontSize: 12, lineHeight: 16, fontWeight: '600' }}>View balance and packs</Text>
                </View>
              </View>
              <ChevronRight size={19} color={theme.colors.muted} />
            </Pressable>

            <View
              accessibilityLabel={totalSalesLoading ? 'Total sales loading' : `Total sales ${formatUsdCents(totalSalesUsdCents)}`}
              style={{
                minHeight: 72,
                borderRadius: 20,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor: theme.colors.border,
                padding: 14,
                backgroundColor: theme.colors.panel,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(theme.colors.workflow, 0.10) }}>
                  <Wallet size={21} color={theme.colors.success} />
                </View>
                <View style={{ gap: 1, minWidth: 0, flex: 1 }}>
                  <Text style={{ color: theme.colors.muted, fontSize: 11, lineHeight: 15, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 }}>Total sales</Text>
                  <Text style={{ color: theme.colors.text, fontSize: 22, lineHeight: 28, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                    {totalSalesLoading ? 'Loading…' : formatUsdCents(totalSalesUsdCents)}
                  </Text>
                </View>
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <MenuRow icon={<Layers3 size={21} color={theme.colors.text} />} label="Templates" onPress={() => navigateAndClose('/templates')} />
              <MenuRow icon={<Gift size={21} color={theme.colors.commerce} />} label="Invite & Earn" onPress={() => navigateAndClose('/invite')} />
              <MenuRow icon={<LayoutDashboard size={21} color={theme.colors.text} />} label="Your Sales" onPress={() => navigateAndClose('/seller-dashboard')} />
              <MenuRow icon={<PackageOpen size={21} color={theme.colors.text} />} label="Your Unlocks" onPress={() => navigateAndClose('/unlocks')} />
              <View style={{ height: 1, backgroundColor: theme.colors.borderSubtle, marginVertical: 4 }} />
              <MenuRow icon={<Settings size={21} color={theme.colors.text} />} label="Settings" onPress={() => navigateAndClose('/settings')} />
              <MenuRow icon={<CircleHelp size={21} color={theme.colors.text} />} label="Help & Support" onPress={() => navigateAndClose('/help')} />
            </View>

            <View style={{ flex: 1, minHeight: 16 }} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={user ? 'Sign out' : 'Sign in'}
              onPress={() => void handleAuthPress()}
              style={({ pressed }) => ({
                minHeight: 52,
                borderRadius: 18,
                borderCurve: 'continuous',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                borderWidth: 1,
                borderColor: user ? theme.semantic.danger.border : theme.colors.primaryFill,
                backgroundColor: user
                  ? (pressed ? theme.colors.surfaceStrong : theme.semantic.danger.background)
                  : (pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill),
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              {user ? <LogOut size={20} color={theme.colors.danger} /> : <LogIn size={20} color={theme.colors.onPrimary} />}
              <Text style={{ color: user ? theme.colors.danger : theme.colors.onPrimary, fontSize: 15, lineHeight: 20, fontWeight: '800' }}>{user ? 'Sign out' : 'Sign in'}</Text>
            </Pressable>
          </ScrollView>
        </AnimatedView>
      </View>
    </ModalSurface>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 16,
        borderCurve: 'continuous',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        backgroundColor: pressed ? theme.colors.pressed : theme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
      })}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceStrong }}>
        {icon}
      </View>
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 15, lineHeight: 20, fontWeight: '700' }}>
        {label}
      </Text>
      <ChevronRight size={18} color={theme.colors.muted} />
    </Pressable>
  );
}

function createAnimatedValue(initialValue: number): Animated.Value | null {
  if (IS_TEST_ENVIRONMENT) return null;
  return new Animated.Value(initialValue);
}

/**
 * Drive the drawer's entrance and exit.
 *
 * A spring, not a timing. The previous `Animated.timing` passed no `easing`,
 * so it fell back to React Native's default `easeInOut` — a symmetric curve
 * that starts slow, which reads as lag on a surface the user just tapped for,
 * and then arrives with no settle at all. That is the whole of why this drawer
 * felt harsh next to the rest of the app.
 */
function animateProgress(
  progress: Animated.Value | null,
  toValue: number,
  reduceMotionEnabled: boolean,
  onComplete: () => void
) {
  if (!progress || !Animated?.spring || reduceMotionEnabled) {
    progress?.setValue(toValue);
    onComplete();
    return;
  }

  progress.stopAnimation();
  Animated.spring(progress, {
    toValue,
    ...appTheme.motion.spring.panel,
    useNativeDriver: true,
  }).start(({ finished }) => {
    if (finished) onComplete();
  });
}
