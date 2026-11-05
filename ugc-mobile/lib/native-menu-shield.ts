import { AppState, type ViewProps } from 'react-native';

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
}

export function isNativeMenuShieldRaised() {
  return raised;
}

/** How far a finger may move on the ••• and still count as a tap that opens the menu. */
export const NATIVE_MENU_TRIGGER_TAP_SLOP = 10;

type TriggerTouch = { x: number; y: number; closesMenu: boolean };
let triggerTouch: TriggerTouch | null = null;

type TouchPoint = { nativeEvent: { pageX: number; pageY: number } };

/**
 * Spread on the view around an iOS menu's ••• (`native-menu.ios.tsx`). React
 * Native sees the tap that opens the menu, and a tap that ends where it began
 * raises the shield, so it is up on every opening.
 *
 * Two touches leave it as it is. A drag that starts on the ••• scrolls the
 * list and opens nothing (one the scroll view takes is cancelled). And a tap
 * that began with the shield up is the one that closes the menu, even on its
 * own •••: the root claims it and lowers the shield as it ends.
 */
export const nativeMenuTriggerTouchProps: Pick<ViewProps, 'onTouchStart' | 'onTouchEnd' | 'onTouchCancel'> = {
  onTouchStart: (event: TouchPoint) => {
    triggerTouch = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, closesMenu: raised };
  },
  onTouchEnd: (event: TouchPoint) => {
    const touch = triggerTouch;
    triggerTouch = null;
    if (!touch || touch.closesMenu) return;
    const moved = Math.hypot(event.nativeEvent.pageX - touch.x, event.nativeEvent.pageY - touch.y);
    if (moved <= NATIVE_MENU_TRIGGER_TAP_SLOP) raiseNativeMenuShield();
  },
  onTouchCancel: () => {
    triggerTouch = null;
  },
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
