import { BookText, CalendarDays, Heart, ShoppingBag, Wand2 } from 'lucide-react';

import { getPostResourceKindLabel, type PostResourceKind } from '@/lib/post-resource-bundles';

interface TextPostPreviewCardProps {
  title: string;
  summary: string;
  sourceLabel?: string | null;
  dateLabel?: string | null;
  saveCount?: number | null;
  remixCount?: number | null;
  unlockLabel?: string | null;
  resourceKinds?: PostResourceKind[];
  className?: string;
  summaryClassName?: string;
  titleClassName?: string;
  showStats?: boolean;
}

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export default function TextPostPreviewCard({
  title,
  summary,
  sourceLabel,
  dateLabel,
  saveCount = null,
  remixCount = null,
  unlockLabel = null,
  resourceKinds = [],
  className,
  summaryClassName,
  titleClassName,
  showStats = true,
}: TextPostPreviewCardProps) {
  const hasStats = showStats && (dateLabel || saveCount !== null || remixCount !== null);

  return (
    <div
      className={joinClasses(
        'rounded-[24px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_34%),linear-gradient(180deg,rgba(13,13,18,0.98),rgba(6,6,9,0.98))] p-5 shadow-[0_22px_70px_-58px_rgba(56,189,248,0.75)]',
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100">
          <BookText className="h-3.5 w-3.5" />
          Tip / note
        </span>
        {sourceLabel ? (
          <span className="rounded-full border border-white/10 bg-black/35 px-3 py-1 text-xs font-medium text-zinc-200">
            {sourceLabel}
          </span>
        ) : null}
      </div>

      <h3 className={joinClasses('mt-4 text-lg font-semibold text-white', titleClassName)}>
        {title}
      </h3>
      <p className={joinClasses('mt-3 line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-zinc-300', summaryClassName)}>
        {summary}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {unlockLabel ? (
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-100">
            <ShoppingBag className="h-3.5 w-3.5" />
            {unlockLabel}
          </span>
        ) : null}
        {resourceKinds.map((kind) => (
          <span
            key={kind}
            className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-300"
          >
            {getPostResourceKindLabel(kind)}
          </span>
        ))}
      </div>

      {hasStats ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          {dateLabel ? (
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              {dateLabel}
            </span>
          ) : null}
          {saveCount !== null ? (
            <span className="inline-flex items-center gap-1.5" aria-label={`${saveCount} saves`}>
              <Heart className="h-3.5 w-3.5" aria-hidden="true" />
              <span aria-hidden="true">{saveCount}</span>
            </span>
          ) : null}
          {remixCount !== null ? (
            <span className="inline-flex items-center gap-1.5" aria-label={`${remixCount} remixes`}>
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span aria-hidden="true">{remixCount}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
