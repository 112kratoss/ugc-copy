'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The one card of Studio.
 *
 * Creations, Post Library and Unlocks used to be three visual systems — tall
 * tiles with boxed stats and a row of coloured icon buttons, wide rows with
 * their own chip and button styles, and small flat cards — for what is the
 * same object each time: a piece of media, the state it is in, and what the
 * owner can do next. This card gives all three the mobile app's model (tile →
 * state chips → primary action → overflow menu) in two densities:
 *
 * - `compact` is the grid tile: media on top, state and actions below.
 * - `expanded` is the library row: media beside a wider body, for the tab
 *   whose job is management rather than browsing.
 *
 * Every surface draws its chips, actions and meta from the helpers exported
 * here, so a colour or a radius changes in one place.
 */

export type StudioCardDensity = 'compact' | 'expanded';

/** A card's overall mood; everything but `default` is a non-interactive state. */
export type StudioCardTone = 'default' | 'processing' | 'failed' | 'archived';

export type StudioChipTone = 'neutral' | 'muted' | 'sky' | 'violet' | 'emerald' | 'amber' | 'rose';

export const STUDIO_GRID_CLASS =
  'grid items-stretch gap-4 xl:gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]';

const CHIP_TONE_CLASS: Record<StudioChipTone, string> = {
  neutral: 'border-white/10 bg-white/[0.04] text-zinc-200',
  muted: 'border-zinc-400/20 bg-zinc-500/10 text-zinc-200',
  sky: 'border-sky-400/20 bg-sky-500/10 text-sky-100',
  violet: 'border-violet-400/20 bg-violet-500/10 text-violet-100',
  emerald: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100',
  amber: 'border-amber-400/20 bg-amber-500/10 text-amber-100',
  rose: 'border-rose-400/20 bg-rose-500/10 text-rose-100',
};

/** A small state pill: publish state, recipe state, origin. */
export function StudioChip({
  tone = 'neutral',
  icon,
  children,
  className = '',
}: {
  tone?: StudioChipTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${CHIP_TONE_CLASS[tone]} ${className}`}>
      {icon ? <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

/** The tiny uppercase kind label that sits on the media tile. */
export function StudioKindBadge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: StudioChipTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] backdrop-blur-md ${CHIP_TONE_CLASS[tone]}`}>
      {icon ? <span className="inline-flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true">{icon}</span> : null}
      {children}
    </div>
  );
}

export type StudioActionVariant = 'primary' | 'secondary' | 'accent' | 'emerald';

const ACTION_VARIANT_CLASS: Record<StudioActionVariant, string> = {
  primary: 'bg-white text-black hover:bg-zinc-200',
  secondary: 'border border-white/10 bg-white/[0.04] text-zinc-100 hover:border-white/20 hover:bg-white/[0.08] hover:text-white',
  accent: 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
  emerald: 'border border-emerald-400/25 bg-emerald-500/10 text-emerald-100 hover:border-emerald-300/35 hover:bg-emerald-500/15',
};

/**
 * Class list for a card action. `full` stretches it across the card, which is
 * how a compact card presents its one primary action.
 */
export function studioActionClass(
  variant: StudioActionVariant,
  options: { size?: 'sm' | 'md'; full?: boolean } = {},
): string {
  const size = options.size === 'md'
    ? 'px-3.5 py-2 text-sm font-semibold'
    : 'px-3 py-2 text-xs font-semibold';
  const width = options.full ? 'w-full justify-center rounded-2xl' : 'rounded-full';
  return `ui-focus-ring inline-flex items-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${size} ${width} ${ACTION_VARIANT_CLASS[variant]}`;
}

export interface StudioMetaItem {
  label: string;
  value: ReactNode;
}

/** One quiet line of facts: "Created Aug 9 · Render 19s · Credits 8". */
export function StudioMeta({ items }: { items: StudioMetaItem[] }) {
  if (items.length === 0) return null;
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <dt className="font-semibold uppercase tracking-[0.14em] text-[10px] text-zinc-600">{item.label}</dt>
          <dd className="flex items-center gap-1 font-medium text-zinc-200">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A boxed block inside the body: the linked post, the recipe. */
export function StudioDetail({
  label,
  labelTone = 'text-zinc-500',
  trailing,
  children,
}: {
  label: string;
  labelTone?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-black/25 p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${labelTone}`}>{label}</div>
          <div className="mt-1 min-w-0">{children}</div>
        </div>
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>
    </div>
  );
}

const SURFACE_TONE_CLASS: Record<StudioCardTone, string> = {
  default:
    'border-white/[0.07] bg-[linear-gradient(180deg,rgba(24,24,27,0.78),rgba(8,8,10,0.96))] shadow-[0_18px_60px_rgba(0,0,0,0.34)] hover:border-white/14 hover:shadow-[0_24px_80px_rgba(0,0,0,0.46)]',
  processing: 'border-yellow-500/20 bg-white/[0.02]',
  failed: 'border-red-500/20 bg-white/[0.02] opacity-60',
  archived: 'border-white/[0.08] bg-white/[0.02]',
};

export interface StudioCardProps {
  density: StudioCardDensity;
  tone?: StudioCardTone;
  /** The media tile's content: a frame, an image, a video, or a placeholder. */
  media: ReactNode;
  /** Sits on the tile's top-left: the kind of thing this is. */
  badge?: ReactNode;
  /** Sits on the tile's top-right, e.g. a download button. */
  mediaOverlay?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  /** State pills; rendered as a wrapping row. */
  chips?: ReactNode;
  meta?: StudioMetaItem[];
  /** A boxed block under the facts: the linked post, the recipe. */
  detail?: ReactNode;
  /** The one thing to do next; a compact card stretches it across. */
  primaryAction?: ReactNode;
  /** Visible secondary actions in the footer. */
  actions?: ReactNode;
  /** The footer's right edge: usually a StudioOverflowMenu. */
  menu?: ReactNode;
  /** Makes the whole card one link (used when it carries no other controls). */
  href?: string;
  as?: 'div' | 'article' | 'li';
  testId?: string;
  className?: string;
}

export default function StudioCard({
  density,
  tone = 'default',
  media,
  badge,
  mediaOverlay,
  title,
  subtitle,
  summary,
  chips,
  meta,
  detail,
  primaryAction,
  actions,
  menu,
  href,
  as: Tag = 'article',
  testId,
  className = '',
}: StudioCardProps) {
  const isCompact = density === 'compact';
  const hasFooter = Boolean(actions || menu);
  const metaItems = meta?.filter((item) => item.value !== null && item.value !== undefined && item.value !== '') ?? [];

  const titleBlock = (
    <div className="min-w-0">
      <h3 className={`line-clamp-2 font-semibold text-white ${isCompact ? 'text-sm leading-5' : 'text-lg leading-6'}`}>
        {title}
      </h3>
      {subtitle ? <p className="mt-1 text-xs text-zinc-500">{subtitle}</p> : null}
    </div>
  );
  const summaryBlock = summary
    ? <p className={`line-clamp-2 text-zinc-400 ${isCompact ? 'text-xs leading-5' : 'max-w-3xl text-sm leading-6'}`}>{summary}</p>
    : null;
  const chipsBlock = chips ? <div className="flex flex-wrap gap-2">{chips}</div> : null;
  const footer = hasFooter ? (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/8 pt-3">
      <div className="flex min-w-0 flex-wrap gap-2">{actions}</div>
      {menu ? <div className="shrink-0">{menu}</div> : null}
    </div>
  ) : null;

  const surface = `group relative overflow-hidden rounded-[24px] border backdrop-blur-md transition duration-300 ${SURFACE_TONE_CLASS[tone]} ${className}`;

  const body = isCompact ? (
    <>
      <div className="relative shrink-0 overflow-hidden bg-black">
        {media}
        {badge}
        {mediaOverlay}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3.5 sm:p-4">
        {chipsBlock}
        {titleBlock}
        {summaryBlock}
        {metaItems.length > 0 ? <StudioMeta items={metaItems} /> : null}
        {detail}
        {primaryAction ? <div>{primaryAction}</div> : null}
        {footer}
      </div>
    </>
  ) : (
    <div className="grid gap-4 p-3 md:grid-cols-[180px_minmax(0,1fr)]">
      <div className="relative overflow-hidden rounded-[18px] border border-white/8 bg-black/60">
        {media}
        {badge}
        {mediaOverlay}
      </div>
      <div className="flex min-w-0 flex-col gap-4 p-1 md:p-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          {titleBlock}
          {chipsBlock ? <div className="shrink-0">{chipsBlock}</div> : null}
        </div>
        {summaryBlock}
        {metaItems.length > 0 ? <StudioMeta items={metaItems} /> : null}
        {detail}
        {primaryAction ? <div>{primaryAction}</div> : null}
        {footer}
      </div>
    </div>
  );

  const layout = isCompact ? 'flex h-full flex-col' : 'block';

  if (href) {
    return (
      <Tag data-testid={testId} className="h-full">
        <Link href={href} className={`${surface} ${layout} ui-focus-ring`}>
          {body}
        </Link>
      </Tag>
    );
  }

  return (
    <Tag data-testid={testId} className={`${surface} ${layout}`}>
      {body}
    </Tag>
  );
}
