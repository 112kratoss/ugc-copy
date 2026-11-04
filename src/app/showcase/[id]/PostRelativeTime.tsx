'use client';

import { useSyncExternalStore } from 'react';

import { formatRelativeTime } from '@/lib/post-feed-presentation';

const MINUTE_MS = 60_000;

function subscribeToMinutes(onMinute: () => void) {
  const interval = window.setInterval(onMinute, MINUTE_MS);
  return () => window.clearInterval(interval);
}

// The same value for a whole minute, as `useSyncExternalStore` needs from a snapshot.
function currentMinute() {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** In UTC, the server's zone, so the browser's render of it matches the page's. */
function formatPostDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/**
 * "3h", "2d": how long ago the post went up. The post page is cached for an
 * hour and more, so the age the server drew it at would go stale; it is drawn
 * at `renderedAt` (what the cached HTML says, which hydration must match) and
 * then at the browser's own clock, minute by minute.
 */
export default function PostRelativeTime({ createdAt, renderedAt }: { createdAt: string; renderedAt: number }) {
  const now = useSyncExternalStore(subscribeToMinutes, currentMinute, () => renderedAt);
  return <span title={formatPostDate(createdAt)}>{formatRelativeTime(createdAt, new Date(now))}</span>;
}
