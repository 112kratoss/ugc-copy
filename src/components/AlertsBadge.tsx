'use client';

import { useUnreadAlertsCount } from '@/components/useUnreadAlertsCount';

/**
 * The unread alerts count as a pill. Rendered inside a positioned link; the
 * caller places it with `className`. A screen reader hears its words as text
 * ("3 unread alerts"), which a link or button named by its content reads; an
 * aria-label on a plain span may not name it and some readers skip it. A
 * control named by an aria-label of its own carries the count in that label.
 */
export default function AlertsBadge({ className = '' }: { className?: string }) {
  const count = useUnreadAlertsCount();
  if (count <= 0) return null;

  return (
    <span
      className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--ui-primary)] px-1 text-[10px] font-extrabold leading-none text-[var(--ui-primary-on)] ${className}`}
    >
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{`${count} unread alerts`}</span>
    </span>
  );
}
