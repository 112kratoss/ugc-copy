import type { CreatorToolId, OwnerPostListItem } from '@/lib/types';
import type { ToolAccent } from '@/lib/theme';

export type HomeToolShortcutId = CreatorToolId | 'workflow';

export interface HomeToolShortcut {
  id: HomeToolShortcutId;
  title: string;
  body: string;
  accent: ToolAccent;
  href: string | null;
  previewVariant: 'kingdom' | 'city' | 'runner' | null;
  badge?: string;
}

export const HOME_TOOL_SHORTCUTS: HomeToolShortcut[] = [
  {
    id: 'image',
    title: 'Image',
    body: 'Polished stills, hooks, and product frames.',
    accent: 'image',
    href: '/create/image',
    previewVariant: 'kingdom',
  },
  {
    id: 'video',
    title: 'Video',
    body: 'Prompt-to-clip scenes for launch content.',
    accent: 'video',
    href: '/create/video',
    previewVariant: 'city',
  },
  {
    id: 'motion',
    title: 'Motion',
    body: 'Animate a face, product, or creator visual.',
    accent: 'motion',
    href: '/create/motion',
    previewVariant: 'runner',
  },
  {
    id: 'workflow',
    title: 'Workflow',
    body: 'Reusable systems are coming to mobile.',
    accent: 'workflow',
    href: null,
    previewVariant: null,
    badge: 'Soon',
  },
];

export function formatCompactCount(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  if (safeValue >= 1_000_000) return `${trimOneDecimal(safeValue / 1_000_000)}M`;
  if (safeValue >= 1_000) return `${trimOneDecimal(safeValue / 1_000)}K`;
  return String(safeValue);
}

export function formatUsdCents(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: safeValue % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(safeValue / 100);
}

export function getOwnerPostSalesSummary(posts: OwnerPostListItem[] | null | undefined) {
  return (posts ?? []).reduce(
    (summary, item) => ({
      salesCount: summary.salesCount + (item.bundle?.salesCount ?? 0),
      earningsUsdCents: summary.earningsUsdCents + (item.bundle?.earningsUsdCents ?? 0),
    }),
    { salesCount: 0, earningsUsdCents: 0 }
  );
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
