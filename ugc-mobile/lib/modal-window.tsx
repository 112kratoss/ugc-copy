import { createContext, useContext, type ReactNode } from 'react';

const ModalWindowContext = createContext(false);

/**
 * Marks what a React Native `Modal` draws as being in that Modal's own window.
 *
 * On Android a Modal is a dialog: a second window, over the activity's. The
 * window focus `AppState` reports there (`blur`, `focus`) is the activity's
 * alone. React Native passes on `Activity.onWindowFocusChanged`, and nothing
 * in the app's binary tells JS of a dialog's focus. A Modal takes the
 * activity's focus as it opens and gives it back as it closes, so whatever it
 * draws hears `blur` just as its own window arrives, and nothing after that:
 * the notification shade pulled over an open Modal reaches JS as no event at
 * all (Pixel 9a emulator, 2026-10-05).
 *
 * Anything that reads `blur` as "something has covered me" asks
 * `useInModalWindow` first, and a Modal that mounts such a thing wraps its
 * children in this. iOS has no such event, and nothing there reads the mark.
 */
export function ModalWindowScope({ children }: { children: ReactNode }) {
  return <ModalWindowContext.Provider value>{children}</ModalWindowContext.Provider>;
}

/** Whether this component is drawn inside a `ModalWindowScope`. */
export function useInModalWindow() {
  return useContext(ModalWindowContext);
}
