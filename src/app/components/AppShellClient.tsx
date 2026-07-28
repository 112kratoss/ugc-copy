'use client';

import {
  Bell,
  HelpCircle,
  Menu,
  Plus,
  WandSparkles,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

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
  { label: 'Explore', ids: ['marketplace', 'workflow'] },
  { label: 'Account', ids: ['invite', 'alerts', 'profile'] },
] as const;

const subscribeToHydration = () => () => undefined;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

function DesktopNavItem({ item, active }: { item: AppNavItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
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
}: {
  item: AppNavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
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

function BottomNavItem({ item, active }: { item: AppNavItem; active: boolean }) {
  const Icon = item.icon;

  if (item.id === 'create') {
    return (
      <Link
        href={item.href}
        prefetch={false}
        aria-current={active ? 'page' : undefined}
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

  const activeItem = useMemo(() => getActiveAppNavItem(pathname), [pathname]);
  const title = useMemo(() => getAppShellTitle(pathname), [pathname]);
  const visibleBottomItems = useMemo(() => {
    const ids = ['home', 'showcase', 'create', 'alerts', 'profile'] as const;
    return ids
      .map((id) => APP_NAV_ITEMS.find((item) => item.id === id))
      .filter((item): item is AppNavItem => Boolean(item));
  }, []);

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
                    <DesktopNavItem key={item.id} item={item} active={activeItem?.id === item.id} />
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

          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
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
          <BottomNavItem key={item.id} item={item} active={activeItem?.id === item.id} />
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
