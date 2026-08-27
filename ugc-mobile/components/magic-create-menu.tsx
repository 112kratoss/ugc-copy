import { FilePlus2, Sparkles } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  Animated,
  BackHandler,
  Modal,
  type ModalProps,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetGrabber, useSheetDismissDrag } from '@/components/sheet-chrome';
import { CREATE_MENU_ACTIONS, type CreateMenuAction, type CreateMenuActionId } from '@/lib/create-menu-view-model';
import { CloseGlyph } from '@/lib/platform-glyphs';
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';

const PRIMARY = appTheme.colors.primary ?? '#FF7A59';
const PRIMARY_STRONG = appTheme.colors.primaryStrong ?? '#FF8A6D';
const ON_PRIMARY = appTheme.colors.onPrimary ?? '#1A0E0A';
// Sheet motion. The panel travels its own measured height so it reads as a sheet arriving from
// the screen edge instead of a box blinking into place, and the two directions use opposite
// curves: entering decelerates into rest, leaving accelerates away.
const SHEET_ENTER_DURATION = 300;
const SHEET_EXIT_DURATION = 220;
// Keeps the panel's drop shadow past the screen edge while it is closed.
const SHEET_HIDDEN_SLOP = 24;
// Written out rather than imported from react-native's `Easing` so the focused component tests,
// whose react-native mock only exposes the primitives this file renders, keep working.
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInCubic = (t: number) => t * t * t;
const IS_TEST_ENVIRONMENT = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const FallbackModal = ({ children, visible }: ModalProps) => (
  visible ? <>{children}</> : null
);
const AnimatedView = (IS_TEST_ENVIRONMENT ? View : Animated.View) as typeof Animated.View;
const ModalSurface: React.ComponentType<ModalProps> = IS_TEST_ENVIRONMENT ? FallbackModal : Modal;

export function MagicCreateMenu({
  visible,
  onClose,
  onAction,
  onExited,
  horizontalInset = 0,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  onAction: (id: CreateMenuActionId) => void;
  onExited?: () => void;
  horizontalInset?: number;
  bottomInset?: number;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const safeBottom = Math.max(resolvedBottomInset(insets.bottom), bottomInset);
  const panelInset = Math.max(12, horizontalInset);
  const panelWidth = Math.min(520, Math.max(0, width - panelInset * 2));
  const actionWidth = Math.max(116, (panelWidth - 52) / 2);
  const reduceMotionEnabled = useReducedMotion();
  const drag = useSheetDismissDrag({ onDismiss: onClose });
  const [rendered, setRendered] = useState(visible);
  const [sheetHeight, setSheetHeight] = useState(0);
  const progress = useRef(createAnimatedValue(visible ? 1 : 0)).current;
  // The slide distance is only known once the panel has been laid out, so opening waits for the
  // first measurement. Without it the sheet would animate from a 0px offset and appear in place.
  const measured = sheetHeight > 0;

  useEffect(() => {
    if (visible) setRendered(true);
  }, [visible]);

  useEffect(() => {
    if (!visible && !rendered) onExited?.();
  }, [onExited, rendered, visible]);

  useEffect(() => {
    if (!rendered) return;
    if (visible && !measured) return;

    animateProgress(progress, visible ? 1 : 0, reduceMotionEnabled, () => {
      if (!visible) setRendered(false);
    });
  }, [measured, progress, reduceMotionEnabled, rendered, visible]);

  useEffect(() => {
    if (IS_TEST_ENVIRONMENT || !visible || !BackHandler.addEventListener) return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });

    return () => subscription.remove();
  }, [onClose, visible]);

  // The scrim reaches full strength by the time the panel is 60% of the way in, so the sheet
  // settles onto an already-dimmed screen rather than darkening the world as it arrives.
  const backdropOpacity = progress
    ? progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0.72, 0.72] })
    : 0.72;
  // No cross-fade: the travel carries the entrance on its own, and fading a moving panel reads
  // as smearing. Opacity is only used to hold the sheet back for the frame before it is measured.
  const sheetOpacity = progress ? (measured ? 1 : 0) : 1;
  // The drag rides on top of the entry travel, added into the same transform
  // entry: two translateY entries would put a JS-driven value beside a
  // native-driven one on the same view.
  const entryTranslateY = progress
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight + SHEET_HIDDEN_SLOP, 0] })
    : 0;
  const sheetTranslateY = progress && drag.translateY
    ? Animated.add(entryTranslateY, drag.translateY)
    : entryTranslateY;

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
      <View
        pointerEvents={visible ? 'auto' : 'none'}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <AnimatedView
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            inset: 0,
            opacity: backdropOpacity,
            backgroundColor: '#000000',
          }}
        >
          <Pressable accessible={false} onPress={onClose} style={{ flex: 1 }} />
        </AnimatedView>

        <AnimatedView
          accessibilityViewIsModal
          importantForAccessibility="yes"
          onLayout={(event) => {
            const nextHeight = event.nativeEvent.layout.height;
            // Ignore sub-pixel churn so a re-layout cannot restart the slide mid-animation.
            setSheetHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
          }}
          style={{
            width: panelWidth,
            alignSelf: 'center',
            overflow: 'hidden',
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.border,
            paddingTop: 4,
            paddingHorizontal: 20,
            paddingBottom: safeBottom + 16,
            backgroundColor: appTheme.colors.panel,
            opacity: sheetOpacity,
            transform: [{ translateY: sheetTranslateY }],
            boxShadow: '0 -16px 42px rgba(0,0,0,0.34)',
          }}
        >
          <SheetGrabber drag={drag} />

          <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                accessibilityRole="header"
                accessibilityLiveRegion="polite"
                style={{ color: appTheme.colors.text, fontSize: 22, lineHeight: 28, fontWeight: '800' }}
              >
                Create or publish
              </Text>
            </View>
            <CloseMenuButton onPress={onClose} />
          </View>

          <Text style={{ marginTop: 4, color: appTheme.colors.muted, fontSize: 14, lineHeight: 20 }}>
            Start with AI, or share work you already have.
          </Text>

          <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'center', gap: 12 }}>
            {CREATE_MENU_ACTIONS.map((action) => (
              <MenuActionButton
                key={action.id}
                action={action}
                width={actionWidth}
                onPress={() => onAction(action.id)}
              />
            ))}
          </View>
        </AnimatedView>
      </View>
    </ModalSurface>
  );
}

function CloseMenuButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close create menu"
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: appTheme.colors.border,
        backgroundColor: pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface,
        opacity: pressed ? 0.78 : 1,
      })}
    >
      <CloseGlyph size={appTheme.icon.feature} color={appTheme.colors.text} />
    </Pressable>
  );
}

function MenuActionButton({ action, width, onPress }: { action: CreateMenuAction; width: number; onPress: () => void }) {
  const isCreate = action.id === 'create';
  const Icon = isCreate ? Sparkles : FilePlus2;
  const foreground = isCreate ? ON_PRIMARY : appTheme.colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityHint={action.body}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        minHeight: 148,
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: isCreate ? PRIMARY : appTheme.colors.border,
        padding: 16,
        backgroundColor: isCreate
          ? (pressed ? PRIMARY_STRONG : PRIMARY)
          : (pressed ? appTheme.colors.surfaceStrong : appTheme.colors.panelSoft),
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isCreate ? 'rgba(26,14,10,0.12)' : appTheme.colors.surfaceStrong,
        }}
      >
        <Icon size={26} color={foreground} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: foreground, fontSize: 17, lineHeight: 22, fontWeight: '800' }}>
          {action.label}
        </Text>
        <Text numberOfLines={2} style={{ color: isCreate ? 'rgba(26,14,10,0.72)' : appTheme.colors.muted, fontSize: 12, lineHeight: 17, fontWeight: '600' }}>
          {action.body}
        </Text>
      </View>
    </Pressable>
  );
}

function createAnimatedValue(initialValue: number): Animated.Value | null {
  if (IS_TEST_ENVIRONMENT) return null;
  return new Animated.Value(initialValue);
}

function animateProgress(
  progress: Animated.Value | null,
  toValue: number,
  reduceMotionEnabled: boolean,
  onComplete: () => void
) {
  if (!progress || !Animated?.timing || reduceMotionEnabled) {
    progress?.setValue(toValue);
    onComplete();
    return;
  }

  const opening = toValue === 1;

  progress.stopAnimation();
  Animated.timing(progress, {
    toValue,
    duration: opening ? SHEET_ENTER_DURATION : SHEET_EXIT_DURATION,
    easing: opening ? easeOutCubic : easeInCubic,
    useNativeDriver: true,
  }).start(({ finished }) => {
    if (finished) onComplete();
  });
}
