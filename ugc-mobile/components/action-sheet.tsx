import { useEffect, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Overlay } from '@/components/overlay-host';
import {
  SHEET_BACKDROP_COLOR,
  SheetGrabber,
  SheetPanel,
  sheetPanelStyle,
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
import { useReducedMotion } from '@/lib/motion';
import { resolvedBottomInset } from '@/lib/safe-area';
import { appTheme } from '@/lib/theme';
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
        style={{ position: 'absolute', inset: 0, backgroundColor: SHEET_BACKDROP_COLOR, opacity: backdropOpacity }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          onPress={cancel}
          style={{ flex: 1 }}
        />
      </Animated.View>
      <SheetPanel
        {...drag.contentPanHandlers}
        accessibilityViewIsModal
        onLayout={presentation.onPanelLayout}
        style={[
          sheetPanelStyle(),
          {
            paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
            opacity: presentation.panelOpacity,
            transform: [{ translateY }],
          },
        ]}
      >
        <SheetGrabber drag={drag} />
        <View style={{ gap: 4, paddingHorizontal: appTheme.spacing.panel, paddingBottom: appTheme.spacing.gap }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: appTheme.colors.text, ...appTheme.type.cardTitle }}
          >
            {request.title}
          </Text>
          {request.message ? (
            <Text numberOfLines={2} style={{ color: appTheme.colors.muted, ...appTheme.type.bodySm }}>
              {request.message}
            </Text>
          ) : null}
        </View>
        {orderActionSheetActions(request.actions).map((action) => (
          <ActionRow key={action.label} action={action} onPress={() => choose(action)} />
        ))}
        <View style={{ height: 1, marginTop: appTheme.spacing.compact, backgroundColor: appTheme.colors.border }} />
        <ActionRow action={{ label: cancelLabel }} muted onPress={cancel} />
      </SheetPanel>
    </View>
  );
}

function ActionRow({
  action,
  muted = false,
  onPress,
}: {
  action: ActionSheetAction;
  muted?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityHint={action.detail}
      accessibilityState={{ disabled: Boolean(action.disabled) }}
      disabled={action.disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        justifyContent: 'center',
        gap: 3,
        paddingHorizontal: appTheme.spacing.panel,
        paddingVertical: appTheme.spacing.gap,
        backgroundColor: pressed ? appTheme.colors.surface : 'transparent',
        opacity: action.disabled ? appTheme.opacity.disabled : 1,
      })}
    >
      <Text
        style={{
          color: action.destructive
            ? appTheme.colors.danger
            : muted
              ? appTheme.colors.muted
              : appTheme.colors.text,
          ...appTheme.type.body,
          fontWeight: '800',
        }}
      >
        {action.label}
      </Text>
      {action.detail ? (
        <Text style={{ color: appTheme.colors.faint, ...appTheme.type.caption }}>{action.detail}</Text>
      ) : null}
    </Pressable>
  );
}
