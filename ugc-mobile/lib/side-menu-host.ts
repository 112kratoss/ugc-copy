import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

/**
 * Whether the workspace side menu (☰ on Home and Explore) is open, held above
 * the tab screens so that the tab bar can draw the menu.
 *
 * The menu is an RN `Modal`, and on Android a Modal's window lives only as long
 * as its host view is on the window. Drawn inside Home's tab screen, the
 * Profile and Credits rows took it down with the screen: they switch tabs,
 * react-native-screens detaches the tab that is left at once on Android, and
 * Home showed bare for two frames before the new tab was drawn (Pixel 9a
 * emulator, 2026-11-03). The tab bar stays on the window across tab switches,
 * as the Create menu it already draws shows, so the menu is drawn there and
 * leaves over the new tab. A root-hosted drawer was tried first and reverted:
 * the overlay host drew it a render late and rebuilt its animated nodes
 * mid-exit, which froze ☰ → Settings.
 *
 * Opening and closing go through this store, read by the tab bar alone with
 * `useSyncExternalStore`, so a ☰ tap renders the menu and nothing else: not
 * the Tabs navigator, and not the screen the tap came from.
 */
export interface SideMenuStore {
  isOpen(): boolean;
  open(): void;
  close(): void;
  subscribe(listener: () => void): () => void;
}

export function createSideMenuStore(): SideMenuStore {
  let open = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (open === next) return;
    open = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    isOpen: () => open,
    open: () => set(true),
    close: () => set(false),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Provided by the tabs layout, around the tab screens and the tab bar. */
export const SideMenuHostContext = createContext<SideMenuStore | null>(null);

export function useSideMenuHost(): SideMenuStore | null {
  return useContext(SideMenuHostContext);
}

const NO_STORE_SUBSCRIBE = () => () => {};
const CLOSED = () => false;

/** The host's open state; false without a host. */
export function useSideMenuHostOpen(store: SideMenuStore | null): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : NO_STORE_SUBSCRIBE,
    store ? store.isOpen : CLOSED,
    store ? store.isOpen : CLOSED,
  );
}

export interface WorkspaceSideMenuState {
  /** True when the tab bar draws the menu, and the screen must not draw one of its own. */
  hosted: boolean;
  visible: boolean;
  open: () => void;
  close: () => void;
}

/**
 * The menu's state for a screen that offers it. Under the tabs layout it is
 * the tab bar's, and the screen draws no menu; anywhere else the screen keeps
 * its own state and draws the menu itself, as before.
 */
export function useWorkspaceSideMenuState(): WorkspaceSideMenuState {
  const store = useSideMenuHost();
  const hostOpen = useSideMenuHostOpen(store);
  const [localOpen, setLocalOpen] = useState(false);
  const openLocal = useCallback(() => setLocalOpen(true), []);
  const closeLocal = useCallback(() => setLocalOpen(false), []);
  if (store) {
    return { hosted: true, visible: hostOpen, open: store.open, close: store.close };
  }
  return { hosted: false, visible: localOpen, open: openLocal, close: closeLocal };
}
