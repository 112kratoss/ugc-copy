import { useNavigationContainerRef } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * How long a menu waits for a screen that never takes over: a tab press a
 * screen prevented, a link that sent the person back to the screen under the
 * menu. A hand-off that does navigate is over long before this, inside the
 * tap's own JS task (see `useMenuHandoff`), so the timer never cuts one short.
 */
const HANDOFF_FALLBACK_MS = 400;

type Handoff<Row extends string> = {
  row: Row;
  /** The focused route when the row was tapped. */
  from: string | undefined;
  /** Another route has taken over: the menu leaves over it. */
  landed: boolean;
  /** Nothing took over: the menu leaves anyway. */
  stalled: boolean;
};

export interface MenuHandoff<Row extends string> {
  /** The row whose screen is being built, drawn as pressed until the menu has left; null otherwise. */
  chosen: Row | null;
  /**
   * True from the render in which the next screen has taken over from the one
   * under the menu (or none is coming): the menu starts its exit then, over the
   * arriving screen, and stays closed until it is opened again.
   */
  leaving: boolean;
  /**
   * Opens a row's screen and keeps the menu up until that screen has been
   * built. One per opening of the menu: a second tap, on any row, does
   * nothing. `navigate` returns `false` when it went nowhere (a prevented tab
   * press), and the menu then leaves at once.
   */
  handOff: (row: Row, navigate: () => boolean | void) => void;
  /** Takes the opening's one choice for a row that opens no screen (Sign out); false once it is taken. */
  claim: () => boolean;
}

/**
 * A menu row that opens another screen keeps the menu where it is until that
 * screen has been built under it, then lets the menu leave over it: the screen
 * starts arriving on the frame the menu starts leaving, and the one the menu
 * was opened over is never uncovered on its own in between.
 *
 * Measured on the Pixel 9a emulator (dev build, 2026-11-03): Create → Generate
 * reached the creator ~560 ms after the tap, the menu sliding out and Profile
 * showing for ~0.3 s first, because the tab bar navigated only once the menu's
 * exit had played (or a 400 ms fallback had fired); ☰ → Settings took 450–860
 * ms, Home flashing between the drawer and Settings. The drawer did navigate at
 * the tap, but expo-router's `router.push` only queues the action
 * (`routingQueue.add`, expo-router 55 `build/global-state/routing.js`) and the
 * navigation container dispatches it from an effect (`useImperativeApiEmitter`,
 * `build/imperative-api.js`). The drawer's close was committed, and its exit
 * started, a render before Settings was even built (~210 ms of JS there).
 *
 * So the tap navigates and notes the focused route, and the menu stays, its row
 * drawn as pressed, until the app's focused route is another one. That is read
 * with `useSyncExternalStore`, whose updates React renders straight away: the
 * render that builds the next screen, the navigation container's `state` event
 * after it and the render that starts the menu's exit all run in the tap's own
 * JS task, so the UI thread gets the new screen's transition and the menu's
 * exit together. A plain `setState` from that event would have waited for a
 * later task. A jump to a tab (`jumpTo`) changes the route at the tap, and the
 * menu leaves in the same render as the tab arrives.
 *
 * `onClose` runs once the menu is leaving, so the owner's own state follows.
 */
export function useMenuHandoff<Row extends string>({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): MenuHandoff<Row> {
  const navigation = useNavigationContainerRef();
  const [handoff, setHandoff] = useState<Handoff<Row> | null>(null);
  // Taken at the tap itself, ahead of the render `handoff` waits for: a second
  // touch that landed while the next screen was being built reaches JS after
  // it and must not open a second screen.
  const claimedRef = useRef(false);
  // The hand-off `onClose` was last run for: once each.
  const closedForRef = useRef<Handoff<Row> | null>(null);

  // Forgotten as the menu opens again, not as it closes: the chosen row stays
  // drawn as pressed while the menu leaves.
  const [openedFor, setOpenedFor] = useState(visible);
  if (visible !== openedFor) {
    setOpenedFor(visible);
    if (visible && handoff !== null) setHandoff(null);
  }

  const waiting = handoff !== null && !handoff.landed && !handoff.stalled;
  // Subscribed only while a hand-off waits: the menus are mounted all the
  // time, and every navigation in the app would otherwise render them.
  const subscribe = useCallback(
    (onChange: () => void) => (waiting ? navigation.addListener('state', onChange) : nothingToRemove),
    [navigation, waiting],
  );
  const readFocusedRoute = useCallback(
    () => (waiting ? focusedRouteKey(navigation) : undefined),
    [navigation, waiting],
  );
  const focusedRoute = useSyncExternalStore(subscribe, readFocusedRoute, readFocusedRoute);
  // Kept from the render that sees the new route, so a Back that returns to
  // the old one before the menu has closed cannot bring the menu back.
  if (handoff !== null && !handoff.landed && !handoff.stalled && focusedRoute !== handoff.from) {
    setHandoff({ ...handoff, landed: true });
  }
  const leaving = handoff !== null && (handoff.landed || handoff.stalled);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setHandoff((current) => (current === handoff ? { ...current, stalled: true } : current));
    }, HANDOFF_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [handoff, waiting]);

  useEffect(() => {
    if (!leaving || closedForRef.current === handoff) return;
    closedForRef.current = handoff;
    onClose();
  }, [handoff, leaving, onClose]);

  // Freed when the menu opens again, not when it closes: a touch that reached
  // a row before the menu's exit was drawn can arrive after the close.
  useEffect(() => {
    if (visible) claimedRef.current = false;
  }, [visible]);

  const claim = () => {
    if (claimedRef.current) return false;
    claimedRef.current = true;
    return true;
  };

  const handOff = (row: Row, navigate: () => boolean | void) => {
    if (!claim()) return;
    // Read before navigating: a jump to a tab changes the route at once.
    const from = focusedRouteKey(navigation);
    // Set before navigating, so a navigation that throws still ends in the
    // fallback's exit rather than in a menu whose rows no longer answer.
    setHandoff({ row, from, landed: false, stalled: false });
    if (navigate() === false) setHandoff({ row, from, landed: false, stalled: true });
  };

  return { chosen: handoff?.row ?? null, leaving, handOff, claim };
}

/**
 * The focused route at the bottom of the tree: a tab as well as a pushed
 * screen. Typed by shape: the app declares no root param list, which leaves
 * the container's own route type empty.
 */
function focusedRouteKey(navigation: { isReady(): boolean; getCurrentRoute(): { key: string } | undefined }) {
  return navigation.isReady() ? navigation.getCurrentRoute()?.key : undefined;
}

function nothingToRemove() {}
