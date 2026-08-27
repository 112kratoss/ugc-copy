import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Overlay } from '@/components/overlay-host';
import { SheetGrabber, SheetPanel, useSheetDismissDrag } from '@/components/sheet-chrome';
import {
  orderActionSheetActions,
  registerActionSheetPresenter,
  type ActionSheetAction,
  type ActionSheetRequest,
} from '@/lib/action-sheet';
import { haptic } from '@/lib/haptics';
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
 */
export function ActionSheetHost() {
  const [request, setRequest] = useState<ActionSheetRequest | null>(null);

  useEffect(() => registerActionSheetPresenter(setRequest), []);

  return (
    <Overlay visible={Boolean(request)}>
      {request ? <ActionSheetSurface request={request} onDone={() => setRequest(null)} /> : null}
    </Overlay>
  );
}

function ActionSheetSurface({ request, onDone }: { request: ActionSheetRequest; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const bottomInset = resolvedBottomInset(insets.bottom);
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  const cancel = () => {
    onDone();
    request.onCancel?.();
  };
  const drag = useSheetDismissDrag({ onDismiss: cancel });
  // An overlay is an ordinary view: unlike a Modal it has no native claim on
  // Android's back key, so it takes one (Modality: always an obvious way out).
  useHardwareBack(true, cancel);

  const choose = (action: ActionSheetAction) => {
    onDone();
    haptic.light();
    action.onPress?.();
  };

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
        onPress={cancel}
        style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.58)' }}
      />
      <SheetPanel
        accessibilityViewIsModal
        style={[
          {
            borderTopLeftRadius: appTheme.radii.xl,
            borderTopRightRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: appTheme.colors.borderStrong,
            backgroundColor: appTheme.colors.panel,
            paddingBottom: Math.max(bottomInset, appTheme.spacing.panel),
          },
          drag.dragStyle,
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
