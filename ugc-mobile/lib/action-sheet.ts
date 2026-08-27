import { Alert } from 'react-native';

/**
 * The app's action sheet, as a call you can make from anywhere.
 *
 * HIG draws the line this replaces. Alerts: "Use an action sheet — not an alert
 * — to offer choices related to an intentional action ... an alert is usually
 * unexpected, generally telling people about a problem." Alerts also cap at
 * "up to three buttons", which the comment options list could exceed. Three
 * flows were built as `Alert.alert` menus anyway — comment options, the
 * visibility picker, and leaving the composer with unsaved work, which is the
 * exact case Action sheets names ("when people cancel the message they're
 * editing in Mail ... an action sheet provides two choices").
 *
 * Alerts stay `Alert.alert`: confirming one destructive action is what the
 * Alerts chapter is for, and the system dialog keeps each platform's own button
 * order, which a custom one would not (decision D2).
 *
 * Split from the surface that draws it (`components/action-sheet.tsx`) so a
 * renderless module like `post-lifecycle` can present one without importing
 * React — the same split `lib/notification-badge` uses.
 */

export interface ActionSheetAction {
  label: string;
  onPress?: () => void;
  /** Renders in the danger colour and sorts to the top of the sheet. */
  destructive?: boolean;
  disabled?: boolean;
  /** A second line explaining the choice. Omit unless it adds something. */
  detail?: string;
}

export interface ActionSheetRequest {
  /** Short enough for one line — a long title truncates or forces a scroll. */
  title: string;
  /** Only when the title and the labels are not enough on their own. */
  message?: string;
  actions: ActionSheetAction[];
  /**
   * Overrides the "Cancel" label. Reserved for a flow where the way out is a
   * named choice rather than a plain cancel; Alerts is explicit that a button
   * cancelling an action is titled "Cancel".
   */
  cancelLabel?: string;
  onCancel?: () => void;
}

type Presenter = (request: ActionSheetRequest) => void;

let presenter: Presenter | null = null;

/** Called by `ActionSheetHost` when it mounts. Returns the unregister. */
export function registerActionSheetPresenter(next: Presenter) {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

/**
 * Destructive first, then the caller's order. Ordering is the primitive's job,
 * not each call site's, so none of them can get it backwards: "Make destructive
 * choices visually prominent ... place these buttons at the top of the action
 * sheet"; "Place the Cancel button at the bottom of the action sheet."
 */
export function orderActionSheetActions(actions: ActionSheetAction[]): ActionSheetAction[] {
  return [
    ...actions.filter((action) => action.destructive),
    ...actions.filter((action) => !action.destructive),
  ];
}

/**
 * Present the sheet. Same shape as `Alert.alert`, so a call site converts in one
 * line and the next one reaches for this instead.
 */
export function showActionSheet(request: ActionSheetRequest) {
  if (presenter) {
    presenter(request);
    return;
  }

  // No host in the tree — a focused component test mounting a screen on its
  // own. Degrade to the system dialog rather than swallowing the interaction.
  // (Android renders at most three buttons there; the host is what lifts that.)
  Alert.alert(request.title, request.message, [
    ...orderActionSheetActions(request.actions).map((action) => ({
      text: action.label,
      style: action.destructive ? ('destructive' as const) : undefined,
      onPress: action.onPress,
    })),
    { text: request.cancelLabel ?? 'Cancel', style: 'cancel' as const, onPress: request.onCancel },
  ]);
}
