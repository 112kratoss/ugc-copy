import { useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui';
import {
  registerDialogPresenter,
  type ConfirmDialogRequest,
  type DialogPresentation,
  type MessageDialogRequest,
} from '@/lib/dialog';
import { MotionView, useSpringState } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

/**
 * The surface behind `showConfirmDialog` / `showMessageDialog`. Mounted once,
 * in the root layout.
 *
 * **Through a `Modal`, not `OverlayHost`.** The two hosts answer opposite
 * questions. `OverlayHost` exists because an RN `Modal` is a separate window on
 * Android and receives no keyboard insets, which a sheet with a text field
 * cannot live without — so the action sheet draws in-window. A dialog has no
 * text field, and needs the thing that costs: a window of its own. Every other
 * surface in this app that raises a confirmation is somewhere an in-window
 * overlay cannot reach — inside another `Modal` (the viewer action sheet, the
 * creation screen, the composer's resource editor), or on a
 * `presentation: 'modal'` route presented above the root view controller (edit
 * profile). One Modal-hosted dialog covers all of them, and Android stacks
 * dialog windows by creation order, so it also draws over the Modal that
 * opened it.
 *
 * It never renders on iOS: `showConfirmDialog` hands that platform its own
 * system alert before the presenter is ever consulted.
 */
export function DialogHost() {
  const [presentation, setPresentation] = useState<DialogPresentation | null>(null);

  useEffect(() => registerDialogPresenter(setPresentation), []);

  // Answering closes the surface *and* settles the promise the caller is
  // holding. Both, always: a dialog that closed without settling would leave an
  // `await showConfirmDialog(...)` hanging for the life of the app.
  const answer = (confirmed: boolean) => {
    if (!presentation) return;
    setPresentation(null);
    if (presentation.kind === 'confirm') presentation.settle(confirmed);
    else presentation.settle();
  };

  return (
    <Modal
      visible={presentation !== null}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      // The settle below is spring-driven and honours Reduce Motion; the
      // platform fade would run underneath it and double the entrance.
      animationType="none"
      // Android's back key, claimed natively by the Modal before any
      // `BackHandler` listener runs. Back means the way out, never the
      // destructive answer.
      onRequestClose={() => answer(false)}
    >
      {presentation ? <DialogSurface presentation={presentation} onAnswer={answer} /> : null}
    </Modal>
  );
}

/**
 * The panel is narrower than the screen and never grows past a comfortable
 * reading measure — a dialog that stretches edge to edge reads as a screen, not
 * as the interruption it is. iOS settles a two-button alert at roughly this
 * width on every phone the app supports.
 */
const DIALOG_MAX_WIDTH = 320;
/**
 * Dialogs appear rather than slide, and the appearance is a small settle inward
 * — the same gesture UIAlertController has made since iOS 7. Anything larger
 * reads as a zoom; anything smaller is indistinguishable from a plain fade.
 */
const DIALOG_ENTRY_SCALE = 1.08;

function DialogSurface({
  presentation,
  onAnswer,
}: {
  presentation: DialogPresentation;
  onAnswer: (confirmed: boolean) => void;
}) {
  // Mounted at rest and released on the next commit, so the settle plays on the
  // way in. `useSpringState` lands instantly under Reduce Motion.
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const progress = useSpringState(entered);
  const scale = progress
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [DIALOG_ENTRY_SCALE, 1] })
    : 1;

  const confirm = presentation.kind === 'confirm' ? presentation.request : null;
  const request: ConfirmDialogRequest | MessageDialogRequest = presentation.request;

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: appTheme.spacing.section,
      }}
    >
      {/*
        A plain view, not a Pressable: dialogs do not dismiss by tapping outside
        them on either platform, and one that did would make a destructive
        question answerable by a stray tap. It still blocks every touch beneath
        it, which is the half that matters.
      */}
      <View style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.overlay }} />
      <MotionView
        accessibilityRole="alert"
        // TalkBack reads the panel the moment it appears. Not
        // `accessibilityViewIsModal`, which is iOS-only and so would be dead
        // code on the one platform this surface ever draws on.
        accessibilityLiveRegion="assertive"
        style={{
          width: '100%',
          maxWidth: DIALOG_MAX_WIDTH,
          borderRadius: appTheme.radii.xl,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: appTheme.colors.border,
          backgroundColor: appTheme.colors.panelSoft,
          paddingTop: appTheme.spacing.panel,
          paddingHorizontal: appTheme.spacing.screen,
          paddingBottom: appTheme.spacing.screen,
          gap: appTheme.spacing.screen,
          opacity: progress ?? 1,
          transform: [{ scale }],
        }}
      >
        {/*
          `selectable={false}` on both: a `Modal` is its own window on Android
          and moves focus into it, and `AppText` leaves text selectable by
          default — so the title opened wearing the selection highlight, a grey
          box across the question. Nothing here is worth copying anyway.
        */}
        <View style={{ gap: appTheme.spacing.unit, paddingHorizontal: appTheme.spacing.unit }}>
          <AppText heading variant="cardTitle" selectable={false} style={{ textAlign: 'center' }}>
            {request.title}
          </AppText>
          {request.message ? (
            <AppText variant="bodySm" color="muted" selectable={false} style={{ textAlign: 'center' }}>
              {request.message}
            </AppText>
          ) : null}
        </View>
        {/*
          One row either way. Side by side is how iOS lays out two buttons — and
          the way out goes on the leading side, so the answer that changes
          nothing is the one under the thumb already moving away from the
          destructive control. A notice puts its single button in the same row,
          where it spans the width on its own; outside a row the buttons'
          `flex: 1` has no main axis to grow along, and the one button laid
          itself out past the bottom of the panel.
        */}
        <View style={{ flexDirection: 'row', gap: appTheme.spacing.compact }}>
          {confirm ? (
            <>
              <DialogButton label={confirm.cancelLabel ?? 'Cancel'} onPress={() => onAnswer(false)} />
              <DialogButton
                label={confirm.confirmLabel}
                destructive={confirm.destructive}
                onPress={() => onAnswer(true)}
              />
            </>
          ) : (
            <DialogButton
              label={(presentation.request as MessageDialogRequest).dismissLabel ?? 'OK'}
              onPress={() => onAnswer(false)}
            />
          )}
        </View>
      </MotionView>
    </View>
  );
}

/**
 * The capsules. The way out carries the fill — iOS gives the prominent button
 * to the safe answer in a destructive alert, so the destructive one is plain
 * text in the danger colour and never the thing the eye lands on first.
 */
function DialogButton({
  label,
  destructive = false,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: appTheme.touch.default,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: appTheme.spacing.gap,
        borderRadius: appTheme.radii.pill,
        borderCurve: 'continuous',
        backgroundColor: destructive
          ? (pressed ? appTheme.semantic.danger.background : 'transparent')
          : (pressed ? appTheme.colors.surfaceStrong : appTheme.colors.surface),
      })}
    >
      <AppText variant="button" color={destructive ? 'danger' : 'text'} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  );
}
