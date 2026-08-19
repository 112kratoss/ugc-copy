'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  Activity,
  ScrollText,
  BadgeIndianRupee,
  Images,
  LayoutDashboard,
  LogOut,
  ShieldAlert,
  Users,
  Wallet,
} from 'lucide-react';
import clsx from 'clsx';

import { Text } from '@/app/components/DesignSystem';

export type AdminNavBadges = {
  moderation?: number;
};

const NAV_ITEMS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/admin/moderation', label: 'Moderation', icon: ShieldAlert, badgeKey: 'moderation' as const },
  { href: '/admin/users', label: 'Users & credits', icon: Users },
  { href: '/admin/revenue', label: 'Revenue', icon: BadgeIndianRupee },
  { href: '/admin/payouts', label: 'Payouts', icon: Wallet },
  { href: '/admin/content', label: 'Content', icon: Images },
  { href: '/admin/activity', label: 'Operator activity', icon: ScrollText },
  { href: '/admin/system', label: 'System', icon: Activity },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({
  username,
  badges,
  children,
}: {
  username: string;
  badges?: AdminNavBadges;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch('/api/admin/session', { method: 'DELETE' });
      router.replace('/admin/login');
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--ui-bg-page)] lg:flex">
      <aside className="border-b border-[var(--ui-border-subtle)] bg-[var(--ui-bg-app)] lg:min-h-screen lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 px-5 py-5">
          <div>
            <Text as="span" variant="caption" className="uppercase tracking-[0.14em]">
              Magicbooklet
            </Text>
            <Text as="div" variant="cardTitle">
              Admin
            </Text>
          </div>
        </div>

        <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-4">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href, item.exact);
            const badgeCount = item.badgeKey ? badges?.[item.badgeKey] ?? 0 : 0;
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'ui-focus-ring flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors',
                  active
                    ? 'bg-[var(--ui-surface-3)] text-[var(--ui-text-primary)]'
                    : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-secondary)]',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="whitespace-nowrap">{item.label}</span>
                {badgeCount > 0 ? (
                  <span className="ml-auto rounded-full bg-[var(--ui-surface-3)] px-2 py-0.5 text-xs font-bold text-[var(--ui-accent-danger)]">
                    {badgeCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="hidden border-t border-[var(--ui-border-subtle)] px-5 py-4 lg:block">
          <Text as="div" variant="caption">
            Signed in as
          </Text>
          <Text as="div" variant="bodySm" className="truncate font-semibold text-[var(--ui-text-secondary)]">
            {username}
          </Text>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="ui-focus-ring mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ui-text-muted)] transition-colors hover:text-[var(--ui-text-primary)] disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
