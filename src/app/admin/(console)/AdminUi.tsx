import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

import { Surface, Text } from '@/app/components/DesignSystem';

export type AdminStatusTone = 'ok' | 'warning' | 'danger' | 'neutral';

const TONE_CLASSES: Record<AdminStatusTone, string> = {
  ok: 'text-[#5ee9a4] bg-[rgba(94,233,164,0.12)]',
  warning: 'text-[#ffc46b] bg-[rgba(255,196,107,0.12)]',
  danger: 'text-[var(--ui-accent-danger)] bg-[rgba(255,124,139,0.12)]',
  neutral: 'text-[var(--ui-text-muted)] bg-[var(--ui-surface-2)]',
};

/**
 * Maps the many status vocabularies in the database (`ok`/`degraded`,
 * `success`/`failed`, `open`/`resolved`, …) onto one visual scale, so a glance
 * down a column means the same thing regardless of which table it came from.
 */
export function statusTone(status: string): AdminStatusTone {
  const normalized = status.toLowerCase();
  if (['ok', 'success', 'succeeded', 'paid', 'completed', 'active', 'resolved', 'dismissed', 'public'].includes(normalized)) {
    return 'ok';
  }
  if (['warning', 'pending', 'processing', 'created', 'reviewing', 'starting', 'shadow', 'skipped'].includes(normalized)) {
    return 'warning';
  }
  if (['degraded', 'failed', 'error', 'open', 'cancelled', 'canceled', 'refunded', 'hidden', 'taken_down'].includes(normalized)) {
    return 'danger';
  }
  return 'neutral';
}

export function StatusBadge({ status, tone }: { status: string; tone?: AdminStatusTone }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold capitalize',
        TONE_CLASSES[tone ?? statusTone(status)],
      )}
    >
      {status.replace(/_/g, ' ') || '—'}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <Text as="h1" variant="sectionTitle">{title}</Text>
        {description ? <Text variant="bodySm" className="mt-1.5">{description}</Text> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: AdminStatusTone;
}) {
  return (
    <Surface variant="card" padding="md">
      <div className="flex items-center justify-between gap-3">
        <Text as="span" variant="caption" className="uppercase tracking-[0.1em]">{label}</Text>
        {Icon ? <Icon className="h-4 w-4 text-[var(--ui-text-faint)]" aria-hidden /> : null}
      </div>
      <p className={clsx(
        'mt-2 text-3xl font-extrabold leading-9 tracking-tight',
        tone === 'danger' ? 'text-[var(--ui-accent-danger)]' : 'text-[var(--ui-text-primary)]',
      )}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {hint ? <Text variant="caption" className="mt-1">{hint}</Text> : null}
    </Surface>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--ui-border-subtle)] px-5 py-10 text-center">
      <Text variant="bodySm">{message}</Text>
    </div>
  );
}

export function DataTable({
  columns,
  children,
}: {
  columns: string[];
  children: ReactNode;
}) {
  return (
    // Wide operational tables scroll inside their own container so the page body
    // never scrolls horizontally on narrow screens.
    <div className="overflow-x-auto rounded-2xl border border-[var(--ui-border-subtle)]">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)]">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="whitespace-nowrap px-4 py-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--ui-text-faint)]"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  mono = false,
  truncateWidth,
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  /**
   * Clips long free-text values (post titles, provider error strings) to this
   * pixel width. The clipping wrapper has to be a block element: `truncate` on
   * an inline child such as a link does not clip, and a table cell grows to fit
   * its content, so an unbounded value pushes every later column out of the row.
   */
  truncateWidth?: number;
  className?: string;
}) {
  return (
    <td
      className={clsx(
        'border-b border-[var(--ui-border-subtle)] px-4 py-3 align-middle text-sm text-[var(--ui-text-secondary)]',
        mono && 'font-mono text-[12px] text-[var(--ui-text-muted)]',
        className,
      )}
    >
      {truncateWidth ? (
        <div className="truncate" style={{ maxWidth: `${truncateWidth}px` }} title={typeof children === 'string' ? children : undefined}>
          {children}
        </div>
      ) : children}
    </td>
  );
}

/**
 * Reads an `offset` query parameter.
 *
 * A hostile or fat-fingered value must not become a negative or fractional
 * range: PostgREST would either error or silently return a different window
 * than the control claims to be showing, so anything unparseable falls back to
 * the first page.
 */
export function parseOffset(value: string | undefined, pageSize: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  // Snap to a page boundary so "showing 12-36 of 400" can never be rendered.
  return Math.floor(parsed / pageSize) * pageSize;
}

/**
 * Every admin list was previously capped at a fixed limit and rendered without
 * any sign that rows had been dropped, so an operator looking past the cap saw
 * a partial answer that looked complete. This states the window explicitly and
 * only offers a direction that actually has rows.
 */
export function Pagination({
  basePath,
  offset,
  pageSize,
  total,
  offsetParam = 'offset',
  otherParams = {},
  noun = 'rows',
}: {
  basePath: string;
  offset: number;
  pageSize: number;
  total: number;
  offsetParam?: string;
  otherParams?: Record<string, string>;
  noun?: string;
}) {
  // `offset` is always a window the query actually returned: each service
  // falls back to the first page when asked for one past the end, so this can
  // never render an impossible range like "showing 1001-7 of 7".
  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + pageSize, total);
  const hasPrevious = offset > 0;
  const hasNext = offset + pageSize < total;

  function hrefForOffset(nextOffset: number): string {
    const query = new URLSearchParams(otherParams);
    if (nextOffset > 0) {
      query.set(offsetParam, String(nextOffset));
    } else {
      query.delete(offsetParam);
    }
    const queryString = query.toString();
    return queryString ? `${basePath}?${queryString}` : basePath;
  }

  // A single page needs no controls, but the count still reassures the operator
  // that nothing was truncated.
  if (!hasPrevious && !hasNext) {
    return total > 0 ? (
      <Text variant="caption" className="mt-3 block">
        {total.toLocaleString()} {noun}
      </Text>
    ) : null;
  }

  return (
    <nav
      aria-label={`${noun} pagination`}
      className="mt-3 flex flex-wrap items-center justify-between gap-3"
    >
      <Text variant="caption">
        Showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of {total.toLocaleString()} {noun}
      </Text>
      <div className="flex items-center gap-2">
        {hasPrevious ? (
          <Link href={hrefForOffset(offset - pageSize)} className="ui-button ui-button-secondary ui-focus-ring">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Previous
          </Link>
        ) : (
          <span className="ui-button ui-button-secondary pointer-events-none opacity-40" aria-disabled>
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Previous
          </span>
        )}
        {hasNext ? (
          <Link href={hrefForOffset(offset + pageSize)} className="ui-button ui-button-secondary ui-focus-ring">
            Next
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : (
          <span className="ui-button ui-button-secondary pointer-events-none opacity-40" aria-disabled>
            Next
            <ChevronRight className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
    </nav>
  );
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** Always rendered in UTC so operator screenshots in an incident agree. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return `${DATE_TIME_FORMAT.format(parsed)} UTC`;
}

export function formatRelative(value: string | null | undefined, now = new Date()): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';

  const minutes = Math.round((now.getTime() - parsed.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatSubunits(subunits: number | null | undefined, currency = 'INR'): string {
  if (subunits === null || subunits === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(subunits / 100);
}

export function shortId(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}
