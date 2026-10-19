'use client';

import {
  Bell,
  HelpCircle,
  Menu,
  Plus,
  Search,
  WandSparkles,
  X,
} from 'lucide-react';
import Form from 'next/form';
import Link from 'next/link';
import { usePathname, useSelectedLayoutSegment } from 'next/navigation';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  APP_NAV_ITEMS,
  getActiveAppNavItem,
  getAppShellTitle,
  isMinimalAppChromePath,
  isNotFoundRouteSegment,
  type AppNavItem,
} from './app-shell-nav';
import DeferredAppShellAccount from './DeferredAppShellAccount';
import AlertsBadge from '@/components/AlertsBadge';

const NAV_GROUPS = [
  { label: 'Create', ids: ['home', 'create', 'studio', 'showcase'] },
  { label: 'Discover', ids: ['search', 'marketplace', 'workflow'] },
  { label: 'Account', ids: ['invite', 'alerts', 'profile'] },
] as const;

const subscribeToHydration = () => () => undefined;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

/**
 * The tabs that scroll back to the top when pressed while already open, as a
 * phone's tab bar does. A tab opened from another page always starts at the
 * top: the shell used to bring back where each of these was left, and a
 * Profile that opened at its last row read as a page that loaded wrong.
 */
const RESELECT_TO_TOP_TAB_IDS = new Set<AppNavItem['id']>([
  'home',
  'showcase',
  'alerts',
  'profile',
]);

type AppNavClickHandler = (
  event: ReactMouseEvent<HTMLAnchorElement>,
  item: AppNavItem
) => void;

function getReselectableTabId(pathname: string) {
  if (pathname === '/' || pathname === '/home') return 'home';

  const item = APP_NAV_ITEMS.find(
    (candidate) => RESELECT_TO_TOP_TAB_IDS.has(candidate.id) && candidate.href === pathname
  );
  return item?.id ?? null;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Next scrolls a new page to its top only when the page's first element is out
 * of view, and a top hidden under the sticky bar still counts as in view. A
 * short page (a min-h-screen root makes it one bar taller than the window)
 * opened from a scrolled one keeps the scroll the browser clamped it to, its top
 * under the bar. That clamp can leave at most the bar's height, so a page found
 * scrolled that little with its top under the bar goes to the top.
 *
 * Not `scroll-padding-top` on the root, the remedy Next's docs give for sticky
 * headers: every focus then scrolls the page to reveal a control already in
 * view in the bar or in the drawer, half a window at a time.
 */
function bringPageTopOutFromUnderBar() {
  const bar = document.querySelector('.app-shell-header');
  const main = document.getElementById('main-content');
  if (!bar || !main) return;

  const barBottom = bar.getBoundingClientRect().bottom;
  if (window.scrollY <= barBottom && main.getBoundingClientRect().top < barBottom) {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

/** Whether a URL hash names something Next scrolls to (its own lookup). */
function hashHasTarget(hash: string) {
  let fragment = hash.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is looked up as written.
  }
  return fragment === 'top'
    || document.getElementById(fragment) !== null
    || document.getElementsByName(fragment).length > 0;
}

function DesktopNavItem({
  item,
  active,
  onNavigate,
}: {
  item: AppNavItem;
  active: boolean;
  onNavigate: AppNavClickHandler;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => onNavigate(event, item)}
      className={`ui-focus-ring group relative flex min-h-11 items-center gap-3 rounded-[14px] border px-3 py-2 text-[13px] font-semibold transition ${
        active
          ? 'border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] text-[var(--ui-text-primary)]'
          : 'border-transparent text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]'
      }`}
      title={item.description}
    >
      {active ? (
        <span className="absolute left-0 h-5 w-[3px] rounded-full bg-[var(--ui-primary)]" aria-hidden />
      ) : null}
      <Icon
        className={`h-[18px] w-[18px] ${
          active ? 'text-[var(--ui-primary)]' : 'text-[var(--ui-text-faint)] group-hover:text-[var(--ui-text-secondary)]'
        }`}
        aria-hidden
      />
      <span>{item.label}</span>
    </Link>
  );
}

function DrawerNavItem({
  item,
  active,
  onClick,
  onNavigate,
}: {
  item: AppNavItem;
  active: boolean;
  onClick: () => void;
  onNavigate: AppNavClickHandler;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        onClick();
        onNavigate(event, item);
      }}
      className={`ui-focus-ring flex min-h-12 items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-bold transition ${
        active
          ? 'border-[rgba(255,122,89,0.28)] bg-[var(--ui-primary-soft)] text-[var(--ui-text-primary)]'
          : 'border-transparent text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]'
      }`}
    >
      <Icon className={`h-[18px] w-[18px] ${active ? 'text-[var(--ui-primary)]' : 'text-[var(--ui-text-faint)]'}`} aria-hidden />
      <span>{item.label}</span>
      {item.id === 'alerts' ? <AlertsBadge className="ml-auto" /> : null}
    </Link>
  );
}

function BottomNavItem({
  item,
  active,
  onNavigate,
}: {
  item: AppNavItem;
  active: boolean;
  onNavigate: AppNavClickHandler;
}) {
  const Icon = item.icon;

  if (item.id === 'create') {
    return (
      <Link
        href={item.href}
        prefetch={false}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => onNavigate(event, item)}
        aria-label="Create"
        className="ui-focus-ring relative flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5 rounded-2xl pb-1 text-xs font-extrabold text-[var(--ui-primary)]"
      >
        <span className="absolute -top-6 flex h-[58px] w-[58px] items-center justify-center rounded-full border-[3px] border-[var(--ui-surface-1)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)] shadow-[0_8px_20px_rgba(0,0,0,0.36)] transition active:scale-[0.985]">
          <Plus className="h-6 w-6" strokeWidth={2.7} aria-hidden />
        </span>
        <span>Create</span>
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => onNavigate(event, item)}
      className={`ui-focus-ring relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-[18px] px-1 py-2 text-[11px] font-bold transition ${
        active
          ? 'bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]'
          : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]'
      }`}
    >
      {active ? <span className="absolute top-1 h-[3px] w-[18px] rounded-full bg-[var(--ui-primary)]" aria-hidden /> : null}
      <Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 2.1} aria-hidden />
      {item.id === 'alerts' ? <AlertsBadge className="absolute left-1/2 top-1.5 ml-1" /> : null}
      <span className="max-w-full truncate">{item.shortLabel}</span>
    </Link>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" prefetch={false} className="ui-focus-ring flex items-center gap-3 rounded-2xl text-[var(--ui-text-primary)]">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[var(--ui-primary)] text-[var(--ui-primary-on)] shadow-[0_10px_24px_rgba(255,122,89,0.18)]">
        <WandSparkles className="h-5 w-5" strokeWidth={2.4} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-extrabold tracking-tight">magicbooklet</span>
        {!compact ? (
          <span className="mt-0.5 block text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ui-text-faint)]">
            Creator studio
          </span>
        ) : null}
      </span>
    </Link>
  );
}

const AppShellFrame = memo(function AppShellFrame({
  isNotFoundRoute,
  children,
}: {
  isNotFoundRoute: boolean;
  children: React.ReactNode;
}) {
  const routePathname = usePathname() || '/';
  const hasMounted = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot
  );
  // The statically rendered root route can be evaluated with an internal Next
  // pathname in production, and signed-in `/` is middleware-rewritten to
  // `/home` (src/proxy.ts), so the server sees `/home` while the hydrated
  // browser sees `/`. Keep both neutral for the first client render so the
  // markup matches the server shell, then activate Home.
  const isHomeBeforeMount = (routePathname === '/' || routePathname === '/home') && !hasMounted;
  // The not-found page keeps the neutral shell it was prerendered with, before
  // and after hydration, at every address (see AppShellClient below).
  const pathname = isNotFoundRoute || isHomeBeforeMount ? '' : routePathname;
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeItem = useMemo(() => getActiveAppNavItem(pathname), [pathname]);
  const title = useMemo(() => getAppShellTitle(pathname), [pathname]);
  const visibleBottomItems = useMemo(() => {
    const ids = ['home', 'showcase', 'create', 'alerts', 'profile'] as const;
    return ids
      .map((id) => APP_NAV_ITEMS.find((item) => item.id === id))
      .filter((item): item is AppNavItem => Boolean(item));
  }, []);

  const handleAppNavClick = useCallback<AppNavClickHandler>((event, item) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    // Pressing the tab that is already open returns it to its top. Any other
    // tab is an ordinary navigation: Next scrolls the new page to its top, and
    // the effect below finishes the job under the bar.
    if (getReselectableTabId(routePathname) !== item.id) return;

    event.preventDefault();
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [routePathname]);

  // Back and Forward bring a page back where the browser left it, which the
  // check below must leave alone: remember where each traversal lands. In the
  // capture phase, so it is noted before Next's own listener commits the page.
  const traversalPathRef = useRef<string | null>(null);
  useEffect(() => {
    const rememberTraversal = () => {
      traversalPathRef.current = window.location.pathname;
    };
    window.addEventListener('popstate', rememberTraversal, { capture: true });
    return () => window.removeEventListener('popstate', rememberTraversal, { capture: true });
  }, []);

  // A layout effect: it runs after Next's own scroll (the page's layout
  // effects come first) but before any page reads the scroll in a passive
  // effect, where Explore's bootstrap would take this reset for the visitor
  // scrolling, and before the frame is painted.
  const previousPathnameRef = useRef(routePathname);
  useLayoutEffect(() => {
    if (previousPathnameRef.current === routePathname) return;
    previousPathnameRef.current = routePathname;

    const traversalPath = traversalPathRef.current;
    traversalPathRef.current = null;
    // A traversal lands where it was left.
    if (traversalPath === routePathname) return;

    const { hash } = window.location;
    if (!hash) {
      bringPageTopOutFromUnderBar();
    } else if (!hashHasTarget(hash) && window.scrollY > 0) {
      // A hash that names no element, as the creator page's tab hashes do:
      // Next drops its scroll altogether and the page keeps the last offset.
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [routePathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }

      if (event.key !== 'Tab' || !drawerRef.current) return;

      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [mobileOpen]);

  if (isMinimalAppChromePath(pathname)) {
    return (
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
    );
  }

  return (
    <div className="app-shell-root">
      <aside className="app-shell-sidebar" aria-label="Primary navigation">
        <div className="px-4 pt-5">
          <Brand />
        </div>

        <nav className="app-scrollbar mt-7 flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ui-text-faint)]">
                {group.label}
              </div>
              <div className="flex flex-col gap-1">
                {group.ids.map((id) => {
                  const item = APP_NAV_ITEMS.find((candidate) => candidate.id === id);
                  return item ? (
                    <DesktopNavItem
                      key={item.id}
                      item={item}
                      active={activeItem?.id === item.id}
                      onNavigate={handleAppNavClick}
                    />
                  ) : null;
                })}
              </div>
            </div>
          ))}
        </nav>

        <Link
          href="/contact"
          prefetch={false}
          className="ui-focus-ring mx-3 mb-4 flex min-h-12 items-center gap-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-3 py-2 text-[13px] font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-default)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ui-surface-inset)] text-[var(--ui-text-secondary)]">
            <HelpCircle className="h-4 w-4" aria-hidden />
          </span>
          <span>Help & feedback</span>
        </Link>
      </aside>

      <div className="app-shell-main" aria-hidden={mobileOpen ? true : undefined}>
        <header className="app-shell-header">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-extrabold text-[var(--ui-text-primary)]">{title}</div>
              {activeItem ? (
                <div className="hidden truncate text-xs text-[var(--ui-text-faint)] lg:block">
                  {activeItem.description}
                </div>
              ) : null}
            </div>
          </div>

          {activeItem?.id !== 'search' ? (
            <Form
              action="/search"
              className="app-shell-search mx-auto min-w-0 basis-md items-center gap-2.5 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 transition focus-within:border-[var(--ui-border-strong)] focus-within:bg-[var(--ui-surface-3)]"
            >
              <button
                type="submit"
                aria-label="Search"
                className="ui-focus-ring -ml-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:text-[var(--ui-text-primary)]"
              >
                <Search className="h-4 w-4" aria-hidden />
              </button>
              <input
                type="search"
                name="q"
                placeholder="Search Magicbooklet"
                aria-label="Search creators, posts, and recipes"
                autoComplete="off"
                className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)]"
              />
            </Form>
          ) : null}

          {/* Never shrinks: the search field gives way (.app-shell-search in globals.css). */}
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {activeItem?.id !== 'search' ? (
              <Link
                href="/search"
                prefetch={false}
                aria-label="Search creators, posts, and recipes"
                className="app-shell-search-link ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
              >
                <Search className="h-[18px] w-[18px]" aria-hidden />
              </Link>
            ) : null}
            <Link
              href="/notifications"
              prefetch={false}
              aria-label="Open alerts"
              className="ui-focus-ring relative hidden h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] sm:inline-flex"
            >
              <Bell className="h-[18px] w-[18px]" aria-hidden />
              <AlertsBadge className="absolute -right-1 -top-1" />
            </Link>
            <Link
              href="/create"
              prefetch={false}
              aria-label="New creation"
              className="app-shell-create ui-focus-ring min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="app-shell-create-label">New creation</span>
            </Link>
            <DeferredAppShellAccount pathname={pathname} />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="app-shell-content app-scrollbar">
          {children}
        </main>
      </div>

      <nav
        className="app-shell-bottom-nav"
        aria-label="Primary mobile navigation"
        aria-hidden={mobileOpen ? true : undefined}
      >
        {visibleBottomItems.map((item) => (
          <BottomNavItem
            key={item.id}
            item={item}
            active={activeItem?.id === item.id}
            onNavigate={handleAppNavClick}
          />
        ))}
      </nav>

      {mobileOpen ? (
        <div
          className="fixed inset-0 z-[80] bg-black/[0.72] backdrop-blur-sm md:hidden"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setMobileOpen(false);
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="ui-enter app-scrollbar flex h-full w-[min(88vw,370px)] flex-col overflow-y-auto border-r border-[var(--ui-border-default)] bg-[var(--ui-bg-app)] p-4 shadow-2xl shadow-black"
          >
            <div className="flex items-center justify-between gap-3">
              <Brand compact />
              <button
                ref={closeButtonRef}
                type="button"
                className="ui-focus-ring flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-2)]"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>

            <nav className="mt-8 flex flex-col gap-6">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ui-text-faint)]">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-1">
                    {group.ids.map((id) => {
                      const item = APP_NAV_ITEMS.find((candidate) => candidate.id === id);
                      return item ? (
                        <DrawerNavItem
                          key={item.id}
                          item={item}
                          active={activeItem?.id === item.id}
                          onClick={() => setMobileOpen(false)}
                          onNavigate={handleAppNavClick}
                        />
                      ) : null;
                    })}
                  </div>
                </div>
              ))}
            </nav>

            <Link
              href="/contact"
              prefetch={false}
              onClick={() => setMobileOpen(false)}
              className="ui-focus-ring mt-8 flex min-h-12 items-center gap-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-3 text-sm font-bold text-[var(--ui-text-secondary)]"
            >
              <HelpCircle className="h-[18px] w-[18px]" aria-hidden />
              Help & feedback
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default function AppShellClient({ children }: { children: React.ReactNode }) {
  // In production every address with no page is answered with the one
  // build-time `/_not-found` prerender. Its shell was drawn for that internal
  // pathname, but the browser reads the address it visited: `/auth/<x>` wants
  // no shell and `/blog/a/b` another title, and on that mismatch React threw
  // the server's markup away. The route tree comes with the page, so this
  // segment reads the same on both sides.
  //
  // Read here, outside the memoised frame: the segment comes from the router's
  // whole state, which also changes when only the query or the hash does (the
  // Explore reel, search), and the frame draws again only when its pathname or
  // this flag changes. The root layout's `children` keeps its identity.
  const isNotFoundRoute = isNotFoundRouteSegment(useSelectedLayoutSegment());
  return <AppShellFrame isNotFoundRoute={isNotFoundRoute}>{children}</AppShellFrame>;
}
