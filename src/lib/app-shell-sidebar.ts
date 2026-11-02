import { useSyncExternalStore } from 'react';

import { APP_SHELL_SIDEBAR_STORAGE_KEY as STORAGE_KEY } from '@/lib/app-shell-sidebar-restore';

/**
 * The app shell's sidebar, hidden or shown from the button at the top bar's start (the owner's
 * ask, 2026-11-02, after the Claude app's own), and kept that way in this browser.
 *
 * The choice lives on the root element as `data-sidebar="hidden"`, which the stylesheet reads
 * (`html[data-sidebar='hidden']` in globals.css). The root layout runs
 * `APP_SHELL_SIDEBAR_RESTORE` (`app-shell-sidebar-restore.ts`) inline, ahead of the shell, so a
 * page is drawn without the sidebar from its first paint: a choice read only once the page's
 * script had run would fold the sidebar away after the page had shown it. A viewer's own convenience: where storage is
 * refused (a private window) the choice lasts for the page.
 */

const listeners = new Set<() => void>();

function readHidden() {
  return document.documentElement.dataset.sidebar === 'hidden';
}

function draw(hidden: boolean) {
  if (hidden) document.documentElement.dataset.sidebar = 'hidden';
  else delete document.documentElement.dataset.sidebar;
  listeners.forEach((listener) => listener());
}

/** Hides or shows the sidebar on this page, and keeps the choice for the next. */
export function setAppShellSidebarHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(STORAGE_KEY, 'hidden');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused: the choice lasts for this page.
  }
  draw(hidden);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // The choice made in another tab reaches this one.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) draw(event.newValue === 'hidden');
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Whether the sidebar is hidden. The server draws it shown; the root element says otherwise after hydration. */
export function useAppShellSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, readHidden, () => false);
}
