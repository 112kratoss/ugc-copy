import { useEffect, useState } from 'react';
import { Animated, Keyboard, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Overlay } from '@/components/overlay-host';
import {
  SheetGrabber,
  SheetPanel,
  useSheetDismissDrag,
  useSheetPresentation,
} from '@/components/sheet-chrome';
import {
  orderActionSheetActions,
  registerActionSheetPresenter,
  type ActionSheetAction,
  type ActionSheetRequest,
} from '@/lib/action-sheet';
import { haptic } from '@/lib/haptics';
import { MotionView, usePressMotion, useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useHardwareBack } from '@/lib/use-hardware-back';

/**
 * The surface behind `showActionSheet`. Mounted once, inside `OverlayHost` in
 * the root layout.
 *
 * Through the overlay host rather than a `Modal` for the reason the host exists
 * (a Modal is a separate window on Android), and because a sheet opened from
 * another sheet has to draw above it — a Modal would draw above the overlay,
 * never the other way round.
 *
 * The request outlives its answer by one exit animation: `visible` drops the
 * moment a row is chosen or the sheet is cancelled, and the request is cleared
 * once the panel has left the screen. A new request arriving mid-exit simply
 * turns the same surface around.
 */
export function ActionSheetHost() {
  const [request, setRequest] = useState<ActionSheetRequest | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => registerActionSheetPresenter((next) => {
    // An overlay takes no window focus, so the keyboard of the page it opens
    // over stays up, over its rows, typing into a field behind the scrim: Report
    // from a comment's ••• in the comments sheet opened this sheet with all four
    // reasons and Cancel under the keys (Pixel_9a, 2026-10-22). It goes as the
    // sheet is asked for; a Modal's own window did this for the sheets before.
    Keyboard.dismiss();
    setRequest(next);
    setVisible(true);
  }), []);

  return (
    <Overlay visible={Boolean(request)}>
      {request ? (
        <ActionSheetSurface
          request={request}
          visible={visible}
          onAnswered={() => setVisible(false)}
          onExited={() => setRequest((current) => (current === request ? null : current))}
        />
      ) : null}
    </Overlay>
  );
}

function ActionSheetSurface({
  request,
  visible,
  onAnswered,
  onExited,
}: {
  request: ActionSheetRequest;
  visible: boolean;
  onAnswered: () => void;
  onExited: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  const cancel = () => {
    onAnswered();
    request.onCancel?.();
  };
  const drag = useSheetDismissDrag({ onDismiss: cancel, visible });
  const presentation = useSheetPresentation({ visible, reducedMotion, onExited });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one (Modality: always an obvious way out).
  useHardwareBack(visible, cancel);

  const choose = (action: ActionSheetAction) => {
    onAnswered();
    haptic.light();
    action.onPress?.();
  };

  // The entrance and the drag share one transform entry, and the scrim thins
  // for both: a JS-driven value beside a native-driven one on the same view
  // does not compose.
  const translateY = drag.translateY && typeof presentation.entryTranslateY !== 'number'
    ? Animated.add(presentation.entryTranslateY, drag.translateY)
    : presentation.entryTranslateY;
  const backdropOpacity = drag.backdropOpacity && typeof presentation.backdropProgress !== 'number'
    ? Animated.multiply(presentation.backdropProgress, drag.backdropOpacity)
    : presentation.backdropProgress;

  return (
    // Answered once: while the exit plays the rows are still on screen, and a
    // second tap must not choose again.
    <View pointerEvents={visible ? 'auto' : 'none'} style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Animated.View
        style={{ position: 'absolute', inset: 0, backgroundColor: theme.colors.scrim, opacity: backdropOpacity }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          onPress={cancel}
          style={{ flex: 1 }}
        />
      </Animated.View>
      {/* A floating card rather than an edge-to-edge sheet: inset from the
          screen's sides and bottom, rounded on all four corners, its choices
          drawn as separate filled rows. The transparent outer view is what
          slides and what gets measured, so the travel covers the gap under the
          card as well and nothing of it shows before the entrance starts. */}
      <SheetPanel
        {...drag.contentPanHandlers}
        accessibilityViewIsModal
        onLayout={presentation.onPanelLayout}
        style={{
          paddingHorizontal: CARD_SCREEN_INSET,
          // Floats above the home indicator rather than under it, the way the
          // system's inset sheets sit; a phone without one gets the same gap
          // the sides have.
          paddingBottom: Math.max(bottomInset, CARD_SCREEN_INSET),
          transform: [{ translateY }],
        }}
      >
        <View
          style={{
            borderRadius: CARD_RADIUS,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.colors.borderStrong,
            backgroundColor: theme.colors.panel,
            boxShadow: theme.shadow.floating.boxShadow,
            paddingHorizontal: CARD_PADDING,
            paddingBottom: CARD_PADDING,
          }}
        >
          <SheetGrabber drag={drag} />
          <View style={{ gap: 4, paddingHorizontal: ROW_PADDING, paddingTop: 2, paddingBottom: appTheme.spacing.gap + 2 }}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{ color: theme.colors.text, ...appTheme.type.cardTitle }}
            >
              {request.title}
            </Text>
            {request.message ? (
              <Text numberOfLines={2} style={{ color: theme.colors.muted, ...appTheme.type.bodySm }}>
                {request.message}
              </Text>
            ) : null}
          </View>
          <View style={{ gap: ROW_GAP }}>
            {orderActionSheetActions(request.actions).map((action) => (
              <ActionRow key={action.label} action={action} onPress={() => choose(action)} />
            ))}
          </View>
          <View style={{ marginTop: appTheme.spacing.gap }}>
            <ActionRow action={{ label: cancelLabel }} cancel onPress={cancel} />
          </View>
        </View>
      </SheetPanel>
    </View>
  );
}

// The card's own geometry. Not spacing tokens: this is the shape of one
// surface. The radius is large and continuous so the card reads as a lifted
// object rather than a page edge; the rows inside step down from it so the
// corners nest (outer radius minus the padding between them).
const CARD_SCREEN_INSET = 8;
const CARD_RADIUS = 32;
const CARD_PADDING = 10;
const ROW_RADIUS = CARD_RADIUS - CARD_PADDING;
const ROW_PADDING = 16;
const ROW_GAP = 6;

function ActionRow({
  action,
  cancel = false,
  onPress,
}: {
  action: ActionSheetAction;
  cancel?: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const tone = action.destructive ? theme.semantic.danger : null;
  // The row springs down under the finger and rebounds on release, the same
  // press the app's other surfaces have — a snapped scale reads as a flicker.
  const motion = usePressMotion(Boolean(action.disabled), { scale: appTheme.motion.scale.pressedCard });
  return (
    <MotionView style={motion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityHint={action.detail}
        accessibilityState={{ disabled: Boolean(action.disabled) }}
        disabled={action.disabled}
        onPress={onPress}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={({ pressed }) => ({
          minHeight: 54,
          justifyContent: 'center',
          alignItems: cancel ? 'center' : 'stretch',
          gap: 2,
          paddingHorizontal: ROW_PADDING,
          paddingVertical: appTheme.spacing.gap - 1,
          borderRadius: ROW_RADIUS,
          borderCurve: 'continuous',
          backgroundColor: tone
            ? tone.background
            : pressed
              ? theme.colors.surfaceStrong
              : theme.colors.surface,
          // A pressed danger row deepens through its own border tint rather than
          // fading: a choice that is about to happen should not look less sure.
          borderWidth: 1,
          borderColor: tone && pressed ? tone.border : 'transparent',
          opacity: action.disabled ? appTheme.opacity.disabled : 1,
        })}
      >
        <Text
          style={{
            color: tone ? tone.foreground : cancel ? theme.colors.muted : theme.colors.text,
            ...appTheme.type.body,
            fontWeight: '700',
          }}
        >
          {action.label}
        </Text>
        {action.detail ? (
          <Text style={{ color: theme.colors.muted, ...appTheme.type.caption }}>{action.detail}</Text>
        ) : null}
      </Pressable>
    </MotionView>
  );
}
