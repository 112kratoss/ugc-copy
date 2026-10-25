export function formatCompactCount(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  if (safeValue >= 1_000_000) return `${trimOneDecimal(safeValue / 1_000_000)}M`;
  if (safeValue >= 1_000) return `${trimOneDecimal(safeValue / 1_000)}K`;
  return String(safeValue);
}

/**
 * Always with cents ("$5.00", never "$5"), as the web's `formatUsdCents` and the
 * server's payout strings print them, so one amount reads the same wherever a
 * seller meets it (audit 03-9).
 */
export function formatUsdCents(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeValue / 100);
}


export function formatRelativeTime(value: string | null | undefined, now = new Date()) {
  if (!value) return 'Just now';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Just now';

  const diffSeconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Just now';

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;

  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function trimOneDecimal(value: number) {
  return value.toFixed(1).replace(/\.0$/, '');
}
