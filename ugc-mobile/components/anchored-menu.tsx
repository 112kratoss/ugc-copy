/**
 * The menu a ••• opens on Android: a rounded panel that grows out of the button
 * that was pressed, an icon on every row, the rail's actions as one row of
 * icons across the top. `components/native-menu.android.tsx` opens it and says
 * why the app draws it; `lib/native-menu.ts` describes a menu.
 *
 * It is drawn through `OverlayHost`, in the app's own window, so it owns what
 * a system menu would have brought with it:
 * - **Its place.** `lib/anchored-menu-layout.ts` puts it under the button, or
 *   over it where there is no room, and never under a system bar or the keys.
 * - **Its motion.** Scale and opacity only, on the native driver, from the
 *   button's own position. It leaves faster than it arrives.
 * - **The way out.** A touch outside closes it as the finger lands and reaches
 *   nothing below, and Android's back key closes it.
 *
 * A screen held in an RN `Modal` is another window on Android, above the
 * overlay host: a menu opened from inside one would be drawn behind it. No •••
 * sits in a Modal today; the first that does has to host its menu there.
 */
import { Check } from 'lucide-react-native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppSchemeScope } from '@/components/app-scheme-scope';
import { Overlay } from '@/components/overlay-host';
import { placeAnchoredMenu, type MenuRect } from '@/lib/anchored-menu-layout';
import { haptic } from '@/lib/haptics';
import { useReducedMotion } from '@/lib/motion';
import {
  compactNativeMenu,
  nativeMenuSectionRows,
  type NativeMenuAction,
  type NativeMenuModel,
} from '@/lib/native-menu';
import { nativeMenuIcon } from '@/lib/native-menu-icons';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';

/** How close the panel may come to the screen's edges and its bars. */
const MENU_SCREEN_MARGIN = appTheme.spacing.compact;
/**
 * Wide enough that "Comments" fits under its icon with three across (at 220 it
 * was cut short); narrow enough to stay a menu on a tablet.
 */
const MENU_MIN_WIDTH = 248;
const MENU_MAX_WIDTH = 300;
const MENU_PADDING = appTheme.spacing.unit;
const MENU_RADIUS = appTheme.radii.lg;
/** The panel's radius less its padding, so a pressed row's corner follows the panel's. */
const MENU_ROW_RADIUS = MENU_RADIUS - MENU_PADDING;
const MENU_ROW_HEIGHT = appTheme.touch.default;
const MENU_QUICK_ACTION_HEIGHT = 60;
/** Reduce Motion: the menu fades in place, and nothing moves. */
const MENU_FADE_MS = 120;
/**
 * Where the panel waits while it is measured: laid out, and nowhere a frame
 * could show it.
 */
const MENU_UNPLACED_LEFT = -10000;

/**
 * Native from its first value, like a sheet's (`useSheetPresentation`): a
 * value changed from JS before its first native animation is applied again at
 * every later layout, over what the native driver has drawn since.
 */
const NATIVE_FROM_THE_START = { useNativeDriver: true };

export interface AnchoredMenuProps {
  /** The button's box in the window, read as it was pressed. */
  anchor: MenuRect;
  model: NativeMenuModel;
  /** False plays the exit; `onExited` follows it. */
  open: boolean;
  /** What TalkBack reads for the menu, e.g. "More options". */
  accessibilityLabel: string;
  onDismiss: () => void;
  onExited: () => void;
}

export function AnchoredMenu(props: AnchoredMenuProps) {
  return (
    // Above the navigator, so it covers the tab bar and any sheet hosted
    // before it; mounted by its button only while it is open or leaving.
    <Overlay visible>
      {/* A menu is app UI: it follows the app's scheme even from the reel,
          which stays dark. */}
      <AppSchemeScope>
        <MenuSurface {...props} />
      </AppSchemeScope>
    </Overlay>
  );
}

type Size = { width: number; height: number };

function MenuSurface({ anchor, model, open, accessibilityLabel, onDismiss, onExited }: AnchoredMenuProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<View>(null);
  const panelRef = useRef<View>(null);
  const [frame, setFrame] = useState<MenuRect | null>(null);
  const [panelSize, setPanelSize] = useState<Size | null>(null);
  const [scrollSize, setScrollSize] = useState({ content: 0, viewport: 0 });
  // The keys as they stood when the menu opened: it opens above them and does
  // not follow them.
  const [keyboardHeight] = useState(visibleKeyboardHeight);
  const [progress] = useState(() => new Animated.Value(0, NATIVE_FROM_THE_START));
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // An overlay is an ordinary view with no claim on Android's back key.
  useHardwareBack(open, onDismiss);

  const quickActions = compactNativeMenu(model).quickActions;
  const rows = nativeMenuSectionRows(model);
  // One column for the icons and the checkmarks, kept on every row once any
  // row uses it, so the labels share a left edge.
  const reserveLeading = rows.some((row) => (
    row.kind === 'action' && (row.action.checked !== undefined || nativeMenuIcon(row.action.systemImage))
  ));

  // The window stands in for the layer until the layer has been measured,
  // which is before the first frame wherever layout can be read at commit.
  const area = frame ?? { x: 0, y: 0, width: window.width, height: window.height };
  const bounds = {
    left: insets.left + MENU_SCREEN_MARGIN,
    top: insets.top + MENU_SCREEN_MARGIN,
    right: area.width - insets.right - MENU_SCREEN_MARGIN,
    bottom: area.height - coveredBottom(insets.bottom, keyboardHeight) - MENU_SCREEN_MARGIN,
  };
  const maxWidth = Math.max(0, Math.min(MENU_MAX_WIDTH, bounds.right - bounds.left));
  const maxHeight = Math.max(0, bounds.bottom - bounds.top);
  const placement = frame && panelSize
    ? placeAnchoredMenu({
      // The button was measured in the window and the panel is placed in this
      // layer: the same space wherever the layer fills the window, and still
      // right where something has moved it.
      anchor: { ...anchor, x: anchor.x - frame.x, y: anchor.y - frame.y },
      panel: panelSize,
      bounds,
    })
    : null;
  const placed = placement !== null;

  const readFrame = () => {
    containerRef.current?.measureInWindow?.((x, y, width, height) => {
      if (!(width > 0 && height > 0)) return;
      setFrame((current) => (
        current && current.x === x && current.y === y && current.width === width && current.height === height
          ? current
          : { x, y, width, height }
      ));
    });
  };
  const keepPanelSize = (width: number, height: number) => {
    if (!(width > 0 && height > 0)) return;
    setPanelSize((current) => (
      current && current.width === width && current.height === height ? current : { width, height }
    ));
  };

  // Both boxes are read as the menu is committed, so the first frame that
  // holds the panel already has it in place. The layout events below repeat
  // the reading where a commit cannot be measured, and whenever a box changes.
  useLayoutEffect(() => {
    readFrame();
    panelRef.current?.measure?.((_x, _y, width, height) => keepPanelSize(width, height));
    // Once, at mount: later changes arrive as layout events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) {
      if (!placed) {
        // Dismissed before it was ever drawn: there is no exit to play.
        onExitedRef.current();
        return;
      }
      const exit = Animated.timing(progress, {
        toValue: 0,
        duration: reducedMotion ? MENU_FADE_MS : appTheme.motion.duration.menuExit,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      exit.start(({ finished }) => {
        if (finished) onExitedRef.current();
      });
      return () => exit.stop();
    }
    if (!placed) return;
    const entrance = reducedMotion
      ? Animated.timing(progress, { toValue: 1, duration: MENU_FADE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      : Animated.spring(progress, { toValue: 1, useNativeDriver: true, ...appTheme.motion.spring.menu });
    entrance.start();
    return () => entrance.stop();
  }, [open, placed, progress, reducedMotion]);

  // TalkBack follows the menu the way it follows a system one: its focus moves
  // in as the menu opens.
  useEffect(() => {
    if (!open || !placed) return;
    const panel = panelRef.current;
    if (panel) focusForAccessibility(panel);
  }, [open, placed]);

  // One node each for as long as the menu lives: a node made again by a render
  // has to be connected again on the native side, and the entrance does not
  // wait for that.
  const scale = useMemo(() => progress.interpolate({
    inputRange: [0, 1],
    outputRange: [appTheme.motion.scale.menuClosed, 1],
  }), [progress]);
  // Solid well before it reaches full size, so what grows is a panel and not
  // a haze; on the way out it shrinks a little first and then goes.
  const opacity = useMemo(() => progress.interpolate({
    inputRange: [0, 0.5],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  }), [progress]);

  const choose = (action: NativeMenuAction) => {
    onDismiss();
    haptic.light();
    action.onSelect();
  };

  const scrollable = scrollSize.content > scrollSize.viewport + 0.5;

  return (
    // Answered once: while the exit plays the rows are still on screen, and a
    // second tap must not choose again, nor the backdrop hold a touch.
    <View
      ref={containerRef}
      collapsable={false}
      pointerEvents={open ? 'auto' : 'none'}
      onLayout={readFrame}
      style={StyleSheet.absoluteFill}
    >
      {/* No scrim: a menu covers a corner of the screen and dims none of it.
          The touch that closes it is taken as it lands, as a system menu
          takes it, and `onPress` is how TalkBack's double tap arrives. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        onPressIn={onDismiss}
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        ref={panelRef}
        accessibilityRole="menu"
        accessibilityLabel={accessibilityLabel}
        accessibilityViewIsModal
        onLayout={(event) => keepPanelSize(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}
        style={[
          {
            position: 'absolute',
            minWidth: Math.min(MENU_MIN_WIDTH, maxWidth),
            maxWidth,
            maxHeight,
            padding: MENU_PADDING,
            borderRadius: MENU_RADIUS,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.panel,
            overflow: 'hidden',
          },
          theme.shadow.floating,
          placement
            ? {
              left: placement.left,
              top: placement.top,
              transformOrigin: [placement.origin.x, placement.origin.y, 0],
            }
            : { left: MENU_UNPLACED_LEFT, top: 0 },
          reducedMotion ? { opacity: progress } : { opacity, transform: [{ scale }] },
        ]}
      >
        <ScrollView
          bounces={false}
          overScrollMode="never"
          scrollEnabled={scrollable}
          showsVerticalScrollIndicator={scrollable}
          onLayout={(event) => {
            const viewport = event.nativeEvent.layout.height;
            setScrollSize((current) => (current.viewport === viewport ? current : { ...current, viewport }));
          }}
          onContentSizeChange={(_width, content) => {
            setScrollSize((current) => (current.content === content ? current : { ...current, content }));
          }}
        >
          {quickActions.length ? (
            <View
              style={{
                flexDirection: 'row',
                gap: MENU_PADDING,
                marginBottom: rows.length ? MENU_PADDING : 0,
              }}
            >
              {quickActions.map((action) => (
                <QuickAction key={action.id} action={action} onPress={() => choose(action)} />
              ))}
            </View>
          ) : null}
          {rows.map((row) => (row.kind === 'divider' ? (
            <View
              key={row.id}
              style={{
                height: 1,
                marginVertical: MENU_PADDING,
                marginHorizontal: appTheme.spacing.gap,
                backgroundColor: theme.colors.border,
              }}
            />
          ) : (
            <MenuRow
              key={row.action.id}
              action={row.action}
              reserveLeading={reserveLeading}
              onPress={() => choose(row.action)}
            />
          )))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function MenuRow({
  action,
  reserveLeading,
  onPress,
}: {
  action: NativeMenuAction;
  reserveLeading: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const Icon = nativeMenuIcon(action.systemImage);
  const picksOne = action.checked !== undefined;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={action.label}
      accessibilityHint={action.subtitle}
      accessibilityState={{
        disabled: Boolean(action.disabled),
        ...(picksOne ? { checked: Boolean(action.checked) } : null),
      }}
      disabled={action.disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: MENU_ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: appTheme.spacing.gap,
        paddingHorizontal: appTheme.spacing.gap,
        paddingVertical: appTheme.spacing.compact,
        borderRadius: MENU_ROW_RADIUS,
        borderCurve: 'continuous',
        backgroundColor: pressed ? theme.colors.surfaceStrong : 'transparent',
        opacity: action.disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      {reserveLeading ? (
        <View style={{ width: appTheme.icon.default, alignItems: 'center' }}>
          {picksOne
            // A pick-one row: the mark sits where iOS puts it, on the leading edge.
            ? (action.checked ? <Check size={appTheme.icon.default} color={theme.colors.primary} /> : null)
            : (Icon ? (
              <Icon
                size={appTheme.icon.default}
                color={action.destructive ? theme.colors.danger : theme.colors.textSecondary}
              />
            ) : null)}
        </View>
      ) : null}
      {/* Shrinks rather than fills: a label's own width is what sizes the panel. */}
      <View style={{ flexShrink: 1 }}>
        <Text
          numberOfLines={2}
          maxFontSizeMultiplier={appTheme.typeScale.control}
          style={{
            color: action.destructive ? theme.colors.danger : theme.colors.text,
            ...appTheme.type.body,
            fontWeight: '500',
          }}
        >
          {action.label}
        </Text>
        {action.subtitle ? (
          <Text
            numberOfLines={2}
            maxFontSizeMultiplier={appTheme.typeScale.control}
            style={{ color: theme.colors.muted, ...appTheme.type.caption, fontWeight: '500' }}
          >
            {action.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * One of the icons across the top: an action the screen already shows (the
 * reel's rail), at a third of a row's cost. The same row iOS draws as a
 * `ControlGroup`.
 */
function QuickAction({ action, onPress }: { action: NativeMenuAction; onPress: () => void }) {
  const theme = useAppTheme();
  const Icon = nativeMenuIcon(action.systemImage);
  const tint = action.destructive ? theme.colors.danger : theme.colors.text;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={action.label}
      accessibilityHint={action.subtitle}
      accessibilityState={{ disabled: Boolean(action.disabled) }}
      disabled={action.disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: MENU_QUICK_ACTION_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: appTheme.spacing.unit,
        paddingHorizontal: appTheme.spacing.unit,
        paddingVertical: appTheme.spacing.compact,
        borderRadius: MENU_ROW_RADIUS,
        borderCurve: 'continuous',
        backgroundColor: pressed ? theme.colors.surfaceStrong : theme.colors.surface,
        opacity: action.disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      {Icon ? <Icon size={appTheme.icon.default} color={tint} /> : null}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={appTheme.typeScale.control}
        style={{ color: tint, ...appTheme.type.caption }}
      >
        {action.label}
      </Text>
    </Pressable>
  );
}

/**
 * The height React Native last reported for the keyboard on screen, or zero.
 * A focused test has no `Keyboard`.
 */
function visibleKeyboardHeight() {
  try {
    return Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * How much of the screen's foot a menu must stay out of. Android reports the
 * keys' height from the top of the navigation bar, so the two add up there;
 * iOS reports it from the screen's edge, home indicator included.
 */
function coveredBottom(bottomInset: number, keyboardHeight: number) {
  if (!(keyboardHeight > 0)) return bottomInset;
  return isAndroid() ? bottomInset + keyboardHeight : Math.max(bottomInset, keyboardHeight);
}

function isAndroid() {
  try {
    return Platform.OS === 'android';
  } catch {
    return false;
  }
}

function focusForAccessibility(view: View) {
  try {
    AccessibilityInfo.sendAccessibilityEvent(view, 'focus');
  } catch {
    // No screen reader API here (a focused test): the menu is still reachable.
  }
}
