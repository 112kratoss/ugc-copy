import * as ReactNative from 'react-native';

/**
 * The app's dialog, as a call you can make from anywhere.
 *
 * **Why this exists at all.** `Alert.alert` is two different surfaces wearing
 * one name. On iOS it is a dark rounded card with a centred title and capsule
 * buttons — exactly what this app wants, and what Apple's Alerts chapter asks
 * for. On Android it is Material's dialog: square corners, a left-aligned title
 * with no card of its own, and upper-case text buttons crowded into the
 * bottom-right. Side by side the two builds do not read as the same product,
 * which is the one thing Design principles/Familiarity asks a cross-platform
 * surface not to do ("once you establish a behavior or appearance for an
 * element, apply it throughout").
 *
 * So iOS keeps the system dialog and Android draws its own, and the platform
 * check lives *here* — one place, so no call site can drift, and none of them
 * has to know which platform it is on.
 *
 * **Still not a menu.** At most two buttons, one of them the way out. Three or
 * more choices, or a choice that is not a confirmation, is what
 * `showActionSheet` is for; `lib/action-sheet.ts` explains that split.
 *
 * Split from the surface that draws it (`components/dialog.tsx`) so a
 * renderless module like `post-lifecycle` can present one without importing
 * React — the same split `lib/action-sheet` uses.
 */

/**
 * Focused component tests mock react-native down to the exports they render,
 * and reading a missing one off the mock namespace throws rather than yielding
 * undefined — same guard as `lib/platform-glyphs` and `lib/use-hardware-back`.
 * Off iOS (and in such a test) the drawn surface is the one that answers.
 */
function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const alertApi = optionalNativeExport(() => ReactNative.Alert);
const IS_IOS = optionalNativeExport(() => ReactNative.Platform.OS) === 'ios';

export interface ConfirmDialogRequest {
  /** A question, short enough for two lines. Usually the whole message. */
  title: string;
  /** Only when the title and the two labels together are not enough. */
  message?: string;
  /** The label on the button that goes through with it. Never "OK". */
  confirmLabel: string;
  /**
   * Draws the confirm button in the danger colour. Opt-in, like
   * `ActionSheetAction.destructive` — a retry or a restore is not destructive
   * just because it is a confirmation.
   */
  destructive?: boolean;
  /**
   * Overrides "Cancel". Reserved for a flow where the control that opened this
   * is itself named Cancel, so a Cancel meaning *stay* would reverse itself.
   */
  cancelLabel?: string;
}

export interface MessageDialogRequest {
  title: string;
  message?: string;
  /** Overrides "OK". Reserved for a notice whose dismissal is itself a step. */
  dismissLabel?: string;
  onDismiss?: () => void;
}

/** What `DialogHost` renders: a request plus the answer channel. */
export type DialogPresentation =
  | { kind: 'confirm'; request: ConfirmDialogRequest; settle: (confirmed: boolean) => void }
  | { kind: 'message'; request: MessageDialogRequest; settle: () => void };

type Presenter = (presentation: DialogPresentation) => void;

let presenter: Presenter | null = null;

/** Called by `DialogHost` when it mounts. Returns the unregister. */
export function registerDialogPresenter(next: Presenter) {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

/**
 * Ask a yes/no question. Resolves true only if the confirm button was pressed —
 * every other way out (Cancel, Android's back key) resolves false, so a caller
 * can treat "not true" as "do nothing" and never strand the person.
 */
export function showConfirmDialog(request: ConfirmDialogRequest): Promise<boolean> {
  const cancelLabel = request.cancelLabel ?? 'Cancel';

  if (IS_IOS || !presenter) {
    // iOS by design; without a host because a focused component test mounted a
    // screen on its own — degrade to the system dialog rather than swallowing
    // the interaction, the way `showActionSheet` does.
    return new Promise((resolve) => {
      if (typeof alertApi?.alert !== 'function') {
        resolve(false);
        return;
      }
      alertApi.alert(request.title, request.message, [
        // Cancel first: with two buttons iOS draws the first on the leading
        // side, and the way out belongs there.
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        {
          text: request.confirmLabel,
          style: request.destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
  }

  return new Promise((resolve) => {
    presenter?.({ kind: 'confirm', request, settle: resolve });
  });
}

/**
 * Say one thing that has already happened — an error, a receipt. One button,
 * because there is nothing to decide.
 *
 * Fire and forget: a caller that needs to act on the dismissal passes
 * `onDismiss` rather than awaiting, so no call site has to `void` a promise it
 * never wanted.
 */
export function showMessageDialog(request: MessageDialogRequest): void {
  if (IS_IOS || !presenter) {
    // Only spell out the button when the caller customised it: the system's own
    // default is already an OK that does nothing, and naming it would be the
    // same dialog with an extra line of code behind it.
    if (request.dismissLabel || request.onDismiss) {
      alertApi?.alert(request.title, request.message, [
        { text: request.dismissLabel ?? 'OK', onPress: request.onDismiss },
      ]);
    } else {
      alertApi?.alert(request.title, request.message);
    }
    return;
  }

  presenter({ kind: 'message', request, settle: () => request.onDismiss?.() });
}

/** Reads an unknown throw the way every error notice in this app words it. */
export function showErrorDialog(title: string, error: unknown, fallback = 'Please try again.') {
  showMessageDialog({
    title,
    message: error instanceof Error && error.message.trim() ? error.message : fallback,
  });
}
