'use client';

import {
  Bell,
  Command,
  HelpCircle,
  Menu,
  Search,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore } from 'react';

import {
  APP_NAV_ITEMS,
  getActiveAppNavItem,
  getAppShellTitle,
  isMinimalAppChromePath,
  type AppNavItem,
} from './app-shell-nav';
import DeferredAppShellAccount from './DeferredAppShellAccount';

const subscribeToHydration = () => () => {};
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

function DesktopNavItem({ item, active }: { item: AppNavItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={item.prefetch}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
        active
          ? 'border border-blue-400/20 bg-blue-500/15 text-blue-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
          : 'text-zinc-400 hover:bg-white/[0.04] hover:text-white'
      }`}
      title={item.description}
    >
      <Icon
        className={`h-4 w-4 ${
          active ? 'text-blue-300' : 'text-zinc-500 group-hover:text-zinc-200'
        }`}
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
      prefetch={item.prefetch}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${
        active
          ? 'bg-blue-500/15 text-blue-100'
          : 'text-zinc-300 hover:bg-white/[0.05] hover:text-white'
      }`}
    >
      <Icon className="h-4 w-4" />
      <span>{item.label}</span>
    </Link>
  );
}

function BottomNavItem({ item, active }: { item: AppNavItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      prefetch={item.prefetch}
      className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10px] font-semibold transition ${
        active ? 'bg-blue-500/15 text-blue-100' : 'text-zinc-500 hover:text-zinc-100'
      }`}
    >
      <Icon className="h-4 w-4" />
      <span className="truncate">{item.shortLabel}</span>
    </Link>
  );
}

export default function AppShellClient({ children }: { children: React.ReactNode }) {
  const currentPathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const hasHydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  );
  const pathname = hasHydrated && currentPathname && currentPathname.length > 0
    ? currentPathname
    : '/';

  const activeItem = useMemo(() => getActiveAppNavItem(pathname), [pathname]);
  const title = useMemo(() => getAppShellTitle(pathname), [pathname]);
  const visibleBottomItems = useMemo(() => {
    const ids = ['home', 'showcase', 'create', 'alerts', 'profile'] as const;
    return ids
      .map((id) => APP_NAV_ITEMS.find((item) => item.id === id))
      .filter((item): item is AppNavItem => Boolean(item));
  }, []);

  if (isMinimalAppChromePath(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="app-shell-root">
      <aside className="app-shell-sidebar">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>

        <Link href="/" className="mt-6 flex items-center gap-3 px-3 text-white">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 text-sm font-bold shadow-lg shadow-blue-500/20">
            M
          </span>
          <span className="text-base font-semibold tracking-tight">magicbooklet</span>
        </Link>

        <nav className="mt-10 flex flex-1 flex-col gap-1 px-3">
          {APP_NAV_ITEMS.map((item) => (
            <DesktopNavItem key={item.id} item={item} active={activeItem?.id === item.id} />
          ))}
        </nav>

        <Link
          href="/contact"
          className="mx-3 mb-4 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black text-white">
            <HelpCircle className="h-4 w-4" />
          </span>
          <span>Quick help</span>
        </Link>
      </aside>

      <div className="app-shell-main">
        <header className="app-shell-header">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-200 transition hover:bg-white/[0.08] md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="truncate text-base font-semibold text-white">{title}</h1>
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            <Link href="/create" className="app-shell-command">
              <Search className="h-4 w-4 text-zinc-500" />
              <span className="min-w-0 flex-1 truncate">Search or jump to...</span>
              <span className="hidden rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 sm:inline-flex">
                <Command className="mr-0.5 h-3 w-3" />K
              </span>
            </Link>

            <button
              type="button"
              className="hidden h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-400 transition hover:bg-white/[0.08] hover:text-white sm:inline-flex"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
            </button>

            <DeferredAppShellAccount />
          </div>
        </header>

        <main className="app-shell-content app-scrollbar">{children}</main>
      </div>

      <nav className="app-shell-bottom-nav">
        {visibleBottomItems.map((item) => (
          <BottomNavItem key={item.id} item={item} active={activeItem?.id === item.id} />
        ))}
      </nav>

      {mobileOpen ? (
        <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm md:hidden">
          <div className="flex h-full w-[min(86vw,360px)] flex-col border-r border-white/10 bg-[#0b0b0d] p-4 shadow-2xl shadow-black">
            <div className="flex items-center justify-between">
              <Link href="/" className="flex items-center gap-3 text-white">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 text-sm font-bold">
                  M
                </span>
                <span className="text-base font-semibold">magicbooklet</span>
              </Link>
              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-zinc-300"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="mt-8 flex flex-col gap-1">
              {APP_NAV_ITEMS.map((item) => (
                <DrawerNavItem
                  key={item.id}
                  item={item}
                  active={activeItem?.id === item.id}
                  onClick={() => setMobileOpen(false)}
                />
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </div>
  );
}
