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
 * responder, and the touch ends the shield. The menu raises it when its content
 * appears (`native-menu.ios.tsx`) and lowers it when a row is chosen.
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
