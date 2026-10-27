'use client';

import { FilePlus2, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

import {
  CREATE_MENU_ITEMS,
  CREATE_MENU_SUBTITLE,
  CREATE_MENU_TITLE,
  getCreateMenuHref,
  type CreateMenuItem,
} from './app-shell-nav';

/** The id the top bar's Create button and the bottom bar's + open the menu by. */
export const APP_SHELL_CREATE_MENU_ID = 'app-shell-create-menu';

const TITLE_ID = `${APP_SHELL_CREATE_MENU_ID}-title`;

/**
 * The click handler of the buttons that open the menu. A browser without
 * popovers never draws it (globals.css), so its button goes to /create, as
 * the shell's Create did before the menu.
 */
export function goToCreateWithoutPopovers() {
  if (typeof HTMLElement.prototype.showPopover === 'function') return;
  window.location.assign('/create');
}

function hideMenu(panel: HTMLElement) {
  // jsdom has no popovers, and hiding one that is already closed is a no-op
  // in some browsers and an error in others.
  if (typeof panel.hidePopover !== 'function') return;
  try {
    if (panel.matches(':popover-open')) panel.hidePopover();
  } catch {
    // Closed already.
  }
}

/**
 * The app's centre + on the web: make something with AI, or post work that is
 * already finished. A native popover, so the browser gives it the top layer,
 * closes it on Escape or a click outside, and hands the focus back to the
 * button that opened it. `pathname` is the shell's, which stays neutral until
 * hydration, so the Post link reads the same on the server and the client.
 */
export default function AppShellCreateMenu({
  pathname,
  routePathname,
}: {
  pathname: string;
  routePathname: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // A choice closes the menu before anything else hears its click: a page
  // with unsaved work holds every link click in the document's capture phase
  // to ask first (`use-leave-guard.ts`), and that question must not come up
  // under the menu. The window's capture phase runs before the document's.
  useEffect(() => {
    const closeOnChoice = (event: MouseEvent) => {
      const panel = panelRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!panel || !target || !panel.contains(target) || !target.closest('a[href]')) return;
      hideMenu(panel);
    };
    window.addEventListener('click', closeOnChoice, true);
    return () => window.removeEventListener('click', closeOnChoice, true);
  }, []);

  // A new page closes it, however that page came.
  useEffect(() => {
    if (panelRef.current) hideMenu(panelRef.current);
  }, [routePathname]);

  return (
    <div
      ref={panelRef}
      id={APP_SHELL_CREATE_MENU_ID}
      popover="auto"
      role="dialog"
      aria-labelledby={TITLE_ID}
      className="app-shell-create-menu"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 pt-1">
          <p id={TITLE_ID} className="text-lg font-extrabold tracking-tight text-[var(--ui-text-primary)]">
            {CREATE_MENU_TITLE}
          </p>
          <p className="mt-1 text-sm text-[var(--ui-text-muted)]">{CREATE_MENU_SUBTITLE}</p>
        </div>
        <button
          type="button"
          popoverTarget={APP_SHELL_CREATE_MENU_ID}
          popoverTargetAction="hide"
          aria-label="Close create menu"
          className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {CREATE_MENU_ITEMS.map((item) => (
          <CreateMenuChoice key={item.id} item={item} href={getCreateMenuHref(item.id, pathname)} />
        ))}
      </div>
    </div>
  );
}

function CreateMenuChoice({ item, href }: { item: CreateMenuItem; href: string }) {
  const isCreate = item.id === 'create';
  const Icon = isCreate ? Sparkles : FilePlus2;
  const bodyId = `${APP_SHELL_CREATE_MENU_ID}-${item.id}`;

  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={item.label}
      aria-describedby={bodyId}
      className={`ui-focus-ring flex min-h-36 flex-col justify-between gap-4 rounded-[20px] border p-4 transition active:scale-[0.985] ${
        isCreate
          ? 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]'
          : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-3)]'
      }`}
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full ${
          isCreate ? 'bg-black/10' : 'bg-[var(--ui-surface-3)]'
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-base font-extrabold leading-5">{item.label}</span>
        <span
          id={bodyId}
          className={`text-xs font-semibold leading-4 ${isCreate ? 'opacity-75' : 'text-[var(--ui-text-muted)]'}`}
        >
          {item.body}
        </span>
      </span>
    </Link>
  );
}
