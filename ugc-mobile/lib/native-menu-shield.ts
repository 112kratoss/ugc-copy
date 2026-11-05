import { AppState, Keyboard, type ViewProps } from 'react-native';

/**
 * The touch that closes a native menu must do nothing else. UIKit gives native
 * apps that: in Files, a tap on the Browse tab while the ••• menu is open only
 * closes the menu. A SwiftUI menu hosted inside React Native's views does not —
 * React Native's touch handler still receives the tap, so the card or tab under
 * the finger fired as the menu closed (simulator, 2026-09-27).
 *
 * So while an iOS menu is open the shield is raised, and the root view claims
 * the next touch in the responder capture phase: nothing below it becomes the
 * responder, and the touch ends the shield. The tap on the ••• raises it
 * (`nativeMenuTriggerTouchProps`, on the view around the menu in
 * `native-menu.ios.tsx`) and choosing a row lowers it.
 *
 * Until 2026-11-05 the menu raised it from `onAppear` on its rows. SwiftUI
 * fires that when it builds the rows, not each time the menu opens: a card's
 * second opening left the shield down, so the tap that closed the menu opened
 * the post under it, and a late firing left it up with no menu, so the next
 * ordinary tap did nothing (iPhone 17 Pro simulator, 2026-11-05).
 */
let raised = false;
/** Counts every lowering, so a touch can tell that a row was chosen while it lasted. */
let lowerings = 0;
let appStateSubscription: { remove: () => void } | null = null;

export function raiseNativeMenuShield() {
  raised = true;
  // A menu the system closes on its own — the app leaving the foreground —
  // must not cost the next tap.
  appStateSubscription ??= AppState.addEventListener('change', (state) => {
    if (state !== 'active') lowerNativeMenuShield();
  });
}

export function lowerNativeMenuShield() {
  raised = false;
  lowerings += 1;
}

export function isNativeMenuShieldRaised() {
  return raised;
}

/** How far a finger may move on the ••• and still count as a tap that opens the menu. */
export const NATIVE_MENU_TRIGGER_TAP_SLOP = 10;

type TriggerTouch = {
  x: number;
  y: number;
  /** The shield was already up: this tap closes an open menu. */
  closesMenu: boolean;
  /** `lowerings` when the touch began: a row chosen before it ends leaves the shield down. */
  lowerings: number;
  keyboardUp: boolean;
};
let triggerTouch: TriggerTouch | null = null;
/** The ••• became the touch's responder: no scroll view took the tap first. */
let triggerOwnsTouch = false;

type TouchPoint = { nativeEvent: { pageX: number; pageY: number } };

function endTriggerTouch() {
  triggerTouch = null;
  triggerOwnsTouch = false;
}

/**
 * Spread on the view around an iOS menu's ••• (`native-menu.ios.tsx`). React
 * Native sees the tap that opens the menu, and a tap that ends where it began
 * raises the shield, so it is up on every opening.
 *
 * Every other touch leaves it as it is, since a shield up with no menu open
 * swallows the next tap, and a tap on a ••• after that opens a menu the closing
 * tap leaks out of again:
 * - a drag that starts on the ••• scrolls the list and opens nothing (one the
 *   scroll view takes is cancelled or terminated);
 * - a tap that only stops a fling: a scroll view that is still moving claims
 *   the touch in the capture phase (`ScrollView`'s `_isAnimating`), so the •••
 *   never becomes its responder, and UIKit opens no menu either. A scroll view
 *   also claims a tap while the keyboard is up, and there UIKit does open the
 *   menu, so with the keyboard up the tap counts without the responder;
 * - a press that slides onto a row and lets go there: the row lowers the shield,
 *   whichever of the two reaches JS first;
 * - a tap that began with the shield up: it closes the menu, even on its own
 *   •••, and the root claims it and lowers the shield as it ends.
 * Becoming the responder costs nothing: the SwiftUI button answers the touch
 * natively, and an ancestor's press no longer fires for a tap on the •••.
 */
export const nativeMenuTriggerTouchProps: Pick<
  ViewProps,
  | 'onTouchStart'
  | 'onTouchEnd'
  | 'onTouchCancel'
  | 'onStartShouldSetResponder'
  | 'onResponderGrant'
  | 'onResponderTerminationRequest'
  | 'onResponderTerminate'
> = {
  onTouchStart: (event: TouchPoint) => {
    triggerTouch = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
      closesMenu: raised,
      lowerings,
      keyboardUp: Keyboard.isVisible(),
    };
  },
  onStartShouldSetResponder: () => true,
  onResponderGrant: () => {
    triggerOwnsTouch = true;
  },
  // A scroll view that starts to move takes the touch over.
  onResponderTerminationRequest: () => true,
  onResponderTerminate: endTriggerTouch,
  onTouchEnd: (event: TouchPoint) => {
    const touch = triggerTouch;
    const owned = triggerOwnsTouch;
    endTriggerTouch();
    if (!touch || touch.closesMenu || touch.lowerings !== lowerings) return;
    if (!owned && !touch.keyboardUp) return;
    const moved = Math.hypot(event.nativeEvent.pageX - touch.x, event.nativeEvent.pageY - touch.y);
    if (moved <= NATIVE_MENU_TRIGGER_TAP_SLOP) raiseNativeMenuShield();
  },
  onTouchCancel: endTriggerTouch,
};

/** Spread on the root view (`app/_layout.tsx`). */
export const nativeMenuTouchGuardProps: Pick<
  ViewProps,
  | 'onStartShouldSetResponderCapture'
  | 'onResponderTerminationRequest'
  | 'onResponderRelease'
  | 'onResponderTerminate'
> = {
  onStartShouldSetResponderCapture: () => raised,
  onResponderTerminationRequest: () => false,
  onResponderRelease: lowerNativeMenuShield,
  onResponderTerminate: lowerNativeMenuShield,
};
