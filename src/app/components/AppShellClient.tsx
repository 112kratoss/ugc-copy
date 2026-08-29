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
import { usePathname } from 'next/navigation';
import {
  useCallback,
  useEffect,
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
  type AppNavItem,
} from './app-shell-nav';
import DeferredAppShellAccount from './DeferredAppShellAccount';

const NAV_GROUPS = [
  { label: 'Create', ids: ['home', 'create', 'studio', 'showcase'] },
  { label: 'Explore', ids: ['search', 'marketplace', 'workflow'] },
  { label: 'Account', ids: ['invite', 'alerts', 'profile'] },
] as const;

const subscribeToHydration = () => () => undefined;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

const RESTORABLE_TAB_IDS = new Set<AppNavItem['id']>([
  'home',
  'showcase',
  'alerts',
  'profile',
]);
const TAB_SCROLL_POSITION_PREFIX = 'magicbooklet:app-tab-scroll:';
const PENDING_TAB_RESTORE_KEY = 'magicbooklet:pending-app-tab-restore';
const RESTORE_SETTLE_MS = 10_000;
const SCROLL_INTENT_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
]);

type AppNavClickHandler = (
  event: ReactMouseEvent<HTMLAnchorElement>,
  item: AppNavItem
) => void;

function isRestorableTab(item: AppNavItem) {
  return RESTORABLE_TAB_IDS.has(item.id);
}

function getRestorableTabId(pathname: string) {
  if (pathname === '/' || pathname === '/home') return 'home';

  const item = APP_NAV_ITEMS.find(
    (candidate) => RESTORABLE_TAB_IDS.has(candidate.id) && candidate.href === pathname
  );
  return item?.id ?? null;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function readStoredScrollPosition(id: AppNavItem['id']) {
  try {
    const storedValue = window.sessionStorage.getItem(`${TAB_SCROLL_POSITION_PREFIX}${id}`);
    if (storedValue === null) return null;
    const value = Number(storedValue);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function storeScrollPosition(id: AppNavItem['id'], top: number) {
  try {
    window.sessionStorage.setItem(
      `${TAB_SCROLL_POSITION_PREFIX}${id}`,
      String(Math.max(0, top))
    );
  } catch {
    // Session storage can be unavailable in privacy-restricted browsers.
  }
}

function readPendingRestore() {
  try {
    const id = window.sessionStorage.getItem(PENDING_TAB_RESTORE_KEY);
    return id && RESTORABLE_TAB_IDS.has(id as AppNavItem['id'])
      ? id as AppNavItem['id']
      : null;
  } catch {
    return null;
  }
}

function storePendingRestore(id: AppNavItem['id'] | null) {
  try {
    if (id) {
      window.sessionStorage.setItem(PENDING_TAB_RESTORE_KEY, id);
    } else {
      window.sessionStorage.removeItem(PENDING_TAB_RESTORE_KEY);
    }
  } catch {
    // The in-memory ref still covers layouts that remain mounted.
  }
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
      scroll={isRestorableTab(item) ? false : undefined}
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
      scroll={isRestorableTab(item) ? false : undefined}
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
      scroll={isRestorableTab(item) ? false : undefined}
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

export default function AppShellClient({ children }: { children: React.ReactNode }) {
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
  const pathname = (routePathname === '/' || routePathname === '/home') && !hasMounted
    ? ''
    : routePathname;
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const scrollPositionsRef = useRef<Partial<Record<AppNavItem['id'], number>>>({});
  const pendingRestoreRef = useRef<AppNavItem['id'] | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const cancelRestoreRef = useRef<(() => void) | null>(null);
  const isRestoringRef = useRef(false);

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

    const currentTabId = getRestorableTabId(routePathname);
    const wasRestoring = isRestoringRef.current;
    cancelRestoreRef.current?.();
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    isRestoringRef.current = false;

    if (currentTabId && !wasRestoring) {
      scrollPositionsRef.current[currentTabId] = window.scrollY;
      storeScrollPosition(currentTabId, window.scrollY);
    }

    if (!isRestorableTab(item)) {
      pendingRestoreRef.current = null;
      storePendingRestore(null);
      return;
    }

    if (currentTabId === item.id) {
      event.preventDefault();
      pendingRestoreRef.current = null;
      storePendingRestore(null);
      scrollPositionsRef.current[item.id] = 0;
      storeScrollPosition(item.id, 0);
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
      return;
    }

    pendingRestoreRef.current = item.id;
    storePendingRestore(item.id);
  }, [routePathname]);

  useEffect(() => {
    const currentTabId = getRestorableTabId(routePathname);
    if (!currentTabId) return;

    const captureScrollPosition = () => {
      if (isRestoringRef.current) return;
      scrollPositionsRef.current[currentTabId] = window.scrollY;
      storeScrollPosition(currentTabId, window.scrollY);
    };

    window.addEventListener('scroll', captureScrollPosition, { passive: true });
    return () => window.removeEventListener('scroll', captureScrollPosition);
  }, [routePathname]);

  useEffect(() => {
    const currentTabId = getRestorableTabId(routePathname);
    const pendingRestore = pendingRestoreRef.current ?? readPendingRestore();
    if (!currentTabId || pendingRestore !== currentTabId) return;

    const top = scrollPositionsRef.current[currentTabId]
      ?? readStoredScrollPosition(currentTabId)
      ?? 0;
    let finished = false;
    let resizeObserver: ResizeObserver | null = null;
    let settleTimeout: number | null = null;
    isRestoringRef.current = true;

    function removeIntentListeners() {
      window.removeEventListener('wheel', finishRestore);
      window.removeEventListener('touchstart', finishRestore);
      window.removeEventListener('pointerdown', finishRestore);
      window.removeEventListener('keydown', handleRestoreKeyDown);
      window.removeEventListener('scroll', handleRestoreScroll);
    }

    function stopRestoreWork() {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
      if (settleTimeout !== null) {
        window.clearTimeout(settleTimeout);
        settleTimeout = null;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      removeIntentListeners();
      cancelRestoreRef.current = null;
      isRestoringRef.current = false;
    }

    function finishRestore() {
      if (finished) return;
      finished = true;
      stopRestoreWork();
      pendingRestoreRef.current = null;
      storePendingRestore(null);
    }

    function handleRestoreKeyDown(event: KeyboardEvent) {
      if (SCROLL_INTENT_KEYS.has(event.key)) finishRestore();
    }

    function handleRestoreScroll() {
      if (Math.abs(window.scrollY - top) > 1) scheduleRestore();
    }

    const restore = () => {
      if (finished) return;
      window.scrollTo({ top, behavior: 'auto' });
    };

    function scheduleRestore() {
      if (finished || restoreFrameRef.current !== null) return;
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        restore();
      });
    }

    cancelRestoreRef.current = finishRestore;
    window.addEventListener('wheel', finishRestore, { passive: true });
    window.addEventListener('touchstart', finishRestore, { passive: true });
    window.addEventListener('pointerdown', finishRestore, { passive: true });
    window.addEventListener('keydown', handleRestoreKeyDown);
    window.addEventListener('scroll', handleRestoreScroll, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        restore();
        scheduleRestore();
      });
      resizeObserver.observe(document.body);
      const mainContent = document.getElementById('main-content');
      if (mainContent) resizeObserver.observe(mainContent);
    }

    settleTimeout = window.setTimeout(finishRestore, RESTORE_SETTLE_MS);
    restore();
    scheduleRestore();

    return () => {
      finished = true;
      stopRestoreWork();
    };
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
              className="mx-auto hidden w-full max-w-md items-center gap-2.5 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 transition focus-within:border-[var(--ui-border-strong)] focus-within:bg-[var(--ui-surface-3)] md:flex"
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

          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            {activeItem?.id !== 'search' ? (
              <Link
                href="/search"
                prefetch={false}
                aria-label="Search creators, posts, and recipes"
                className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] md:hidden"
              >
                <Search className="h-[18px] w-[18px]" aria-hidden />
              </Link>
            ) : null}
            <Link
              href="/notifications"
              prefetch={false}
              aria-label="Open alerts"
              className="ui-focus-ring hidden h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] sm:inline-flex"
            >
              <Bell className="h-[18px] w-[18px]" aria-hidden />
            </Link>
            <Link
              href="/create"
              prefetch={false}
              className="ui-focus-ring hidden min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] md:inline-flex"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New creation
            </Link>
            <DeferredAppShellAccount />
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
}
