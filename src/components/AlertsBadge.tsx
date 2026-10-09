'use client';

import { useUnreadAlertsCount } from '@/components/useUnreadAlertsCount';

/**
 * The unread alerts count as a pill. Rendered inside a positioned link; the
 * caller places it with `className`.
 */
export default function AlertsBadge({ className = '' }: { className?: string }) {
  const count = useUnreadAlertsCount();
  if (count <= 0) return null;

  return (
    <span
      aria-label={`${count} unread alerts`}
      className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--ui-primary)] px-1 text-[10px] font-extrabold leading-none text-[var(--ui-primary-on)] ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
