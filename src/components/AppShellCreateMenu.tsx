'use client';

import { FilePlus2, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef } from 'react';

import {
  CREATE_MENU_ITEMS,
  CREATE_MENU_SUBTITLE,
  CREATE_MENU_TITLE,
  getCreateMenuHref,
  type CreateMenuItem,
} from './app-shell-nav';

/** The id the top bar's Create button and the bottom bar's + open the menu by. */
export const APP_SHELL_CREATE_MENU_ID = 'app-shell-create-menu';

/** Each choice's icon, here and in the drawer that names the two where the bottom bar hides. */
export const CREATE_MENU_ICONS = { create: Sparkles, post: FilePlus2 } as const;

const TITLE_ID = `${APP_SHELL_CREATE_MENU_ID}-title`;
// How a browser without popovers asks the menu to open: its buttons cannot.
const OPEN_WITHOUT_POPOVERS_EVENT = 'app-shell-create-menu:open';

function supportsPopovers() {
  return typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
}


// The choices, first to last. On the composer Post is a button: the page it
// names is already open.
const CHOICES = 'a[href], button[aria-current]';

/**
 * What the menu does while it is open, as a popover or drawn by hand, until
 * the undo it returns:
 *
 * - The focus goes in, onto the first choice, so a screen reader reads the
 *   dialog where it opens rather than after the whole page, and goes back to
 *   where it was as the menu closes (the browser does that for a popover).
 * - The keys are the menu's: heard first, on the window in the capture phase,
 *   and kept from the page beneath. Escape always, because the workflow canvas
 *   cancels one to clear its selection and a cancelled Escape is no close
 *   request, so the menu stayed open. Any other key while the focus is in the
 *   menu, because Enter on a choice opened the canvas's node editor too, and
 *   Delete removed its selection. A key still does what it does by default:
 *   Tab moves the focus, and Enter follows the choice.
 */
function holdWhileOpen(menu: HTMLElement, onEscape: () => void) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menu.querySelector<HTMLElement>(CHOICES)?.focus({ preventScroll: true });
  const keepKeys = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && !(event.target instanceof Node && menu.contains(event.target))) return;
    event.stopPropagation();
    if (event.key === 'Escape') onEscape();
  };
  window.addEventListener('keydown', keepKeys, true);
  return () => {
    window.removeEventListener('keydown', keepKeys, true);
    const focused = document.activeElement;
    if (opener && opener !== menu && (!focused || focused === document.body || menu.contains(focused))) {
      opener.focus({ preventScroll: true });
    }
  };
}

/**
 * The click handler of the buttons that open the menu. A browser with
 * popovers opens it from their `popovertarget`; one without gets the same
 * menu drawn by the component itself.
 */
export function openCreateMenuWithoutPopovers() {
  if (supportsPopovers()) return;
  window.dispatchEvent(new Event(OPEN_WITHOUT_POPOVERS_EVENT));
}

/**
 * The app's centre + on the web: make something with AI, or post work that is
 * already finished. A native popover, so the browser gives it the top layer,
 * closes it on Escape or a click outside, and hands the focus back to the
 * button that opened it.
 *
 * On a phone the popover fills the window: its scrim is an element of its own
 * that takes the tap that dismisses it, because a popover's `::backdrop` never
 * takes pointer events and a tap there would also land on the page under it.
 *
 * `pathname` is the shell's, which stays neutral until hydration, so the links
 * read the same on the server and the client.
 */
export default function AppShellCreateMenu({
  pathname,
  routePathname,
}: {
  pathname: string;
  routePathname: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Where the browser has no popovers, the menu's open state is its
  // `data-open`, set and cleared by hand as a browser sets a popover's.
  const releaseWithoutPopoversRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    const menu = panelRef.current;
    if (!menu) return;
    if (supportsPopovers()) {
      if (menu.matches(':popover-open')) menu.hidePopover();
      return;
    }
    menu.removeAttribute('data-open');
    releaseWithoutPopoversRef.current?.();
    releaseWithoutPopoversRef.current = null;
  }, []);

  useEffect(() => {
    const menu = panelRef.current;
    if (!menu || supportsPopovers()) return;
    const open = () => {
      if (menu.hasAttribute('data-open')) return;
      menu.setAttribute('data-open', '');
      // The browser closes a popover on Escape; without one, the menu does.
      releaseWithoutPopoversRef.current = holdWhileOpen(menu, close);
    };
    window.addEventListener(OPEN_WITHOUT_POPOVERS_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_WITHOUT_POPOVERS_EVENT, open);
      close();
    };
  }, [close]);

  useEffect(() => {
    const menu = panelRef.current;
    if (!menu || !supportsPopovers()) return;
    let release: (() => void) | null = null;
    const onToggle = (event: Event) => {
      release?.();
      release = (event as ToggleEvent).newState === 'open' ? holdWhileOpen(menu, () => {}) : null;
    };
    // Opened before hydration: its toggle may have gone by unheard.
    if (menu.matches(':popover-open')) release = holdWhileOpen(menu, () => {});
    menu.addEventListener('toggle', onToggle);
    return () => {
      menu.removeEventListener('toggle', onToggle);
      release?.();
    };
  }, []);

  // A choice closes the menu before anything else hears its click: a page
  // with unsaved work holds every link click in the document's capture phase
  // to ask first (`use-leave-guard.ts`), and the question should not come up
  // over a menu still open. The window's capture phase runs before the
  // document's. (A question that comes up any other way, from a Back, puts the
  // menu away itself: `useModalQuestion`.)
  useEffect(() => {
    const closeOnChoice = (event: MouseEvent) => {
      const menu = panelRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (!menu || !target || !menu.contains(target) || !target.closest('a[href]')) return;
      close();
    };
    window.addEventListener('click', closeOnChoice, true);
    return () => window.removeEventListener('click', closeOnChoice, true);
  }, [close]);

  // A new page closes it, however that page came. Not on the first commit:
  // the button opens the popover before hydration, and the menu it opened
  // stays open.
  const shownPathnameRef = useRef(routePathname);
  useEffect(() => {
    if (shownPathnameRef.current === routePathname) return;
    shownPathnameRef.current = routePathname;
    close();
  }, [close, routePathname]);

  return (
    <div
      ref={panelRef}
      id={APP_SHELL_CREATE_MENU_ID}
      popover="auto"
      role="dialog"
      aria-labelledby={TITLE_ID}
      className="app-shell-create-menu"
    >
      <div className="app-shell-create-menu-scrim" aria-hidden onClick={close} />
      <div className="app-shell-create-menu-panel">
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
            onClick={close}
            aria-label="Close create menu"
            className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {CREATE_MENU_ITEMS.map((item) => (
            <CreateMenuChoice
              key={item.id}
              item={item}
              // The composer itself: Post is the page already open, and a link
              // to it would keep the draft on screen under a new address.
              href={item.id === 'post' && pathname === '/post/new' ? null : getCreateMenuHref(item.id, pathname)}
              onCurrentPage={close}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CreateMenuChoice({
  item,
  href,
  onCurrentPage,
}: {
  item: CreateMenuItem;
  /** Null for the page already open: the choice only closes the menu. */
  href: string | null;
  onCurrentPage: () => void;
}) {
  const isCreate = item.id === 'create';
  const Icon = CREATE_MENU_ICONS[item.id];
  const bodyId = `${APP_SHELL_CREATE_MENU_ID}-${item.id}`;
  const className = `ui-focus-ring flex min-h-36 flex-col justify-between gap-4 rounded-[20px] border p-4 text-left transition active:scale-[0.985] ${
    isCreate
      ? 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]'
      : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-primary)] hover:bg-[var(--ui-surface-3)]'
  }`;
  const content = (
    <>
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
    </>
  );

  if (href === null) {
    return (
      <button
        type="button"
        onClick={onCurrentPage}
        aria-label={item.label}
        aria-describedby={bodyId}
        aria-current="page"
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <Link href={href} prefetch={false} aria-label={item.label} aria-describedby={bodyId} className={className}>
      {content}
    </Link>
  );
}
