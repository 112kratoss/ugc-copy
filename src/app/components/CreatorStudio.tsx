import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Expand, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';

import {
  CREATOR_TOOLS,
  type CreatorToolAccent,
  type CreatorToolDefinition,
  type CreatorToolId,
  getCreatorTool,
} from '@/lib/creator-tools';
import { getGenerationTimingSummaryLabel, type GenerationTiming } from '@/lib/generation-timing';

const ACCENT_STYLES: Record<
  CreatorToolAccent,
  {
    border: string;
    shadow: string;
    focusRing: string;
    iconWrap: string;
    badge: string;
    button: string;
    surface: string;
    accentText: string;
  }
> = {
  blue: {
    border: 'hover:border-sky-300/20',
    shadow: 'hover:shadow-[0_28px_80px_-46px_rgba(56,189,248,0.65)]',
    focusRing: 'focus-visible:border-sky-300/35 focus-visible:ring-sky-300/35',
    iconWrap: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    button: 'bg-sky-300 text-slate-950 hover:bg-sky-200',
    surface: 'from-sky-500/20 via-sky-400/10 to-transparent',
    accentText: 'text-sky-300',
  },
  rose: {
    border: 'hover:border-rose-300/20',
    shadow: 'hover:shadow-[0_28px_80px_-46px_rgba(251,113,133,0.65)]',
    focusRing: 'focus-visible:border-rose-300/35 focus-visible:ring-rose-300/35',
    iconWrap: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    button: 'bg-rose-300 text-slate-950 hover:bg-rose-200',
    surface: 'from-rose-500/20 via-fuchsia-400/10 to-transparent',
    accentText: 'text-rose-300',
  },
  violet: {
    border: 'hover:border-violet-300/20',
    shadow: 'hover:shadow-[0_28px_80px_-46px_rgba(167,139,250,0.68)]',
    focusRing: 'focus-visible:border-violet-300/35 focus-visible:ring-violet-300/35',
    iconWrap: 'border-violet-400/20 bg-violet-400/10 text-violet-100',
    badge: 'border-violet-400/20 bg-violet-400/10 text-violet-100',
    button: 'bg-violet-300 text-slate-950 hover:bg-violet-200',
    surface: 'from-violet-500/20 via-indigo-400/10 to-transparent',
    accentText: 'text-violet-300',
  },
  emerald: {
    border: 'hover:border-emerald-300/20',
    shadow: 'hover:shadow-[0_28px_80px_-46px_rgba(52,211,153,0.6)]',
    focusRing: 'focus-visible:border-emerald-300/35 focus-visible:ring-emerald-300/35',
    iconWrap: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    button: 'bg-emerald-300 text-slate-950 hover:bg-emerald-200',
    surface: 'from-emerald-500/20 via-teal-400/10 to-transparent',
    accentText: 'text-emerald-300',
  },
};

const MEDIA_TOOL_IDS: CreatorToolId[] = ['image', 'video', 'motion'];
export type StudioMediaPreviewType = 'image' | 'video';

interface SectionHeadingProps {
  eyebrow: string;
  title: string;
  description?: string;
  actionHref?: string;
  actionLabel?: string;
  variant?: 'default' | 'minimal';
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actionHref,
  actionLabel,
  variant = 'default',
}: SectionHeadingProps) {
  const isMinimal = variant === 'minimal';

  return (
    <div
      className={clsx(
        'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
        isMinimal ? 'mb-4' : 'mb-6'
      )}
    >
      <div className={clsx(isMinimal ? 'max-w-xl' : 'max-w-2xl')}>
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.28em] text-zinc-500">
          {eyebrow}
        </div>
        <h2
          className={clsx(
            'font-semibold tracking-tight text-white',
            isMinimal ? 'text-[1.7rem] sm:text-[2rem]' : 'text-2xl sm:text-3xl'
          )}
        >
          {title}
        </h2>
        {description ? (
          <p
            className={clsx(
              'text-zinc-400',
              isMinimal ? 'mt-2 text-sm leading-6' : 'mt-3 text-sm leading-6 sm:text-base'
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actionHref && actionLabel ? (
        <Link
          href={actionHref}
          className={clsx(
            'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] text-zinc-100 transition hover:bg-white/[0.06]',
            isMinimal
              ? 'px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.18em]'
              : 'px-4 py-2 text-sm font-medium'
          )}
        >
          {actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
      ) : null}
    </div>
  );
}

interface CreatorToolCardProps {
  tool: CreatorToolDefinition;
  variant?: 'suite' | 'launchpad';
  preview?: ReactNode;
}

export function CreatorToolCard({
  tool,
  variant = 'suite',
  preview,
}: CreatorToolCardProps) {
  const theme = ACCENT_STYLES[tool.accent];
  const Icon = tool.icon;
  const isLaunchpad = variant === 'launchpad';
  const prefetch = tool.id === 'workflow' || tool.id === 'video' ? false : undefined;

  return (
    <Link
      href={tool.href}
      prefetch={prefetch}
      className={clsx(
        'group relative block h-full cursor-pointer overflow-hidden border border-white/8 bg-[linear-gradient(180deg,rgba(18,18,22,0.98),rgba(9,9,12,0.96))] transition duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
        theme.border,
        theme.shadow,
        theme.focusRing,
        isLaunchpad
          ? 'h-full min-h-[318px] rounded-[30px] p-4 sm:p-5'
          : 'h-full min-h-[286px] rounded-[26px] p-3.5 sm:p-4'
      )}
    >
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <article className="flex h-full flex-col">
        <div
          className={clsx(
            'relative overflow-hidden border border-white/8 bg-black/30',
            isLaunchpad ? 'rounded-[24px]' : 'rounded-[20px]'
          )}
        >
          {preview ? (
            <div className={clsx('w-full bg-black', isLaunchpad ? 'h-44 sm:h-48' : 'h-40 sm:h-44')}>
              {preview}
            </div>
          ) : (
            <div
              className={clsx(
                'relative w-full bg-gradient-to-br',
                theme.surface,
                isLaunchpad ? 'h-44 sm:h-48' : 'h-40 sm:h-44'
              )}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_35%)]" />
              <div className="absolute inset-0 bg-[linear-gradient(145deg,transparent_0%,rgba(255,255,255,0.04)_52%,transparent_100%)] opacity-70" />
            </div>
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
          <div
            className={clsx(
              'pointer-events-none absolute left-4 top-4 flex items-center justify-center rounded-2xl border backdrop-blur-sm',
              theme.iconWrap,
              isLaunchpad ? 'h-12 w-12' : 'h-11 w-11'
            )}
          >
            <Icon className={clsx(isLaunchpad ? 'h-5 w-5' : 'h-4 w-4')} />
          </div>
          <div className="pointer-events-none absolute bottom-4 left-4 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/85">
            {tool.shortLabel}
          </div>
        </div>

        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
              {tool.eyebrow}
            </div>
            <h3
              className={clsx(
                'mt-2 font-semibold tracking-tight text-white',
                isLaunchpad ? 'text-[1.65rem]' : 'text-[1.3rem]'
              )}
            >
              {tool.label}
            </h3>
          </div>
          <span
            className={clsx(
              'rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
              theme.badge
            )}
          >
            {tool.badge}
          </span>
        </div>

        <p className="mt-3 max-w-[28ch] text-sm leading-6 text-zinc-300">{tool.summary}</p>

        <div className="mt-auto pt-4">
          <div
            className={clsx(
              'inline-flex w-full items-center justify-between rounded-[18px] px-4 py-3 text-sm font-semibold transition',
              theme.button
            )}
          >
            {tool.launchLabel}
            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
          </div>
        </div>
      </article>
    </Link>
  );
}

interface GeneratorQuickSwitchProps {
  currentToolId: CreatorToolId;
  toolIds?: CreatorToolId[];
}

export function GeneratorQuickSwitch({
  currentToolId,
  toolIds,
}: GeneratorQuickSwitchProps) {
  const visibleTools = (toolIds ?? CREATOR_TOOLS.map((tool) => tool.id)).map((toolId) =>
    getCreatorTool(toolId)
  );

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar">
      {visibleTools.map((tool) => {
        const isActive = tool.id === currentToolId;
        const Icon = tool.icon;

        return (
          <Link
            key={tool.id}
            href={tool.href}
            prefetch={tool.id === 'workflow' || tool.id === 'video' ? false : undefined}
            className={clsx(
              'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition',
              isActive
                ? 'border-white/15 bg-white/[0.08] text-white'
                : 'border-white/8 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
            )}
          >
            <Icon className="h-4 w-4" />
            {tool.shortLabel}
          </Link>
        );
      })}
    </div>
  );
}

interface GeneratorPageHeaderProps {
  currentToolId: CreatorToolId;
  title: string;
  eyebrow: string;
  description: string;
  credits: number | null;
  backHref?: string;
  showPathSwitcher?: boolean;
}

export function GeneratorPageHeader({
  currentToolId,
  title,
  eyebrow,
  description,
  credits,
  backHref = '/create',
  showPathSwitcher = true,
}: GeneratorPageHeaderProps) {
  const tool = getCreatorTool(currentToolId);
  const theme = ACCENT_STYLES[tool.accent];

  return (
    <section className="mb-8 rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] p-5 shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)] sm:p-7">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <Link
              href={backHref}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-200 transition hover:bg-white/[0.06]"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="max-w-2xl">
              <div className="text-xs font-semibold uppercase tracking-[0.26em] text-zinc-500">{eyebrow}</div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-[2.25rem]">{title}</h1>
                <span className={clsx('rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]', theme.badge)}>
                  {tool.badge}
                </span>
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">{description}</p>
            </div>
          </div>

          {credits !== null ? (
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-100">
              <Sparkles className={clsx('h-4 w-4', theme.accentText)} />
              <span>{credits}</span>
              <span className="text-zinc-500">credits</span>
            </div>
          ) : null}
        </div>

        {showPathSwitcher ? (
          <div className="space-y-3 rounded-[24px] border border-white/8 bg-black/30 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
              Switch creator path
            </div>
            <GeneratorQuickSwitch currentToolId={currentToolId} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StudioPanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={clsx(
        'rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,rgba(20,20,24,0.96),rgba(9,9,11,0.94))] shadow-[0_24px_90px_-56px_rgba(0,0,0,0.95)]',
        className
      )}
    >
      {children}
    </section>
  );
}

export function MediaStudioRail({
  currentToolId,
}: {
  currentToolId: CreatorToolId;
}) {
  return (
    <aside className="hidden lg:flex lg:flex-col lg:gap-3">
      <StudioPanel className="sticky top-24 p-3">
        <Link
          href="/create"
          className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-[20px] border border-white/10 bg-white/[0.03] px-3 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Hub
        </Link>

        <div className="flex flex-col gap-2">
          {MEDIA_TOOL_IDS.map((toolId) => {
            const tool = getCreatorTool(toolId);
            const Icon = tool.icon;
            const theme = ACCENT_STYLES[tool.accent];
            const isActive = tool.id === currentToolId;

            return (
              <Link
                key={tool.id}
                href={tool.href}
                prefetch={tool.id === 'video' ? false : undefined}
                className={clsx(
                  'group flex flex-col items-center gap-2 rounded-[24px] border px-3 py-4 text-center transition',
                  isActive
                    ? 'border-white/12 bg-white/[0.06] text-white'
                    : 'border-white/8 bg-white/[0.02] text-zinc-400 hover:border-white/12 hover:bg-white/[0.05] hover:text-white'
                )}
              >
                <span
                  className={clsx(
                    'flex h-11 w-11 items-center justify-center rounded-2xl border transition',
                    isActive
                      ? theme.iconWrap
                      : 'border-white/10 bg-white/[0.04] text-zinc-300 group-hover:bg-white/[0.08]'
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                  {tool.shortLabel}
                </span>
              </Link>
            );
          })}
        </div>
      </StudioPanel>
    </aside>
  );
}

export function MediaStudioShell({
  currentToolId,
  header,
  controls,
  workspace,
}: {
  currentToolId: CreatorToolId;
  header: ReactNode;
  controls: ReactNode;
  workspace: ReactNode;
}) {
  return (
    <div className="studio-shell-wide relative z-10">
      {header}

      <div className="mb-4 lg:hidden">
        <StudioPanel className="p-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            Switch creator path
          </div>
          <GeneratorQuickSwitch currentToolId={currentToolId} toolIds={MEDIA_TOOL_IDS} />
        </StudioPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[108px_minmax(0,520px)_minmax(0,1fr)] xl:grid-cols-[108px_minmax(0,560px)_minmax(0,1fr)]">
        <MediaStudioRail currentToolId={currentToolId} />
        <div className="min-w-0 space-y-4">{controls}</div>
        <div className="min-w-0 space-y-4">{workspace}</div>
      </div>
    </div>
  );
}

export function StudioControlCard({
  title,
  description,
  children,
  meta,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <StudioPanel className={clsx('p-5 sm:p-6', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {description ? <p className="mt-1 text-sm text-zinc-400">{description}</p> : null}
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </div>
      {children}
    </StudioPanel>
  );
}

export function StudioRemixNotice({
  label = 'Remixing Community Creation',
  description,
  action,
}: {
  label?: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <StudioPanel className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-200/90">
              {label}
            </div>
            <p className="mt-1 text-sm text-zinc-300">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </StudioPanel>
  );
}

export function StudioRunPanel({
  title,
  summary,
  details,
  action,
  status,
  footer,
}: {
  title: string;
  summary: ReactNode;
  details?: ReactNode;
  action: ReactNode;
  status?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <StudioPanel className="p-5 sm:p-6">
      <div className="space-y-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            Run summary
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">{title}</h2>
        </div>
        <div>{summary}</div>
        {details ? <div className="rounded-[22px] border border-white/8 bg-black/30 p-4">{details}</div> : null}
        <div>{action}</div>
        {status ? <div className="rounded-[22px] border border-white/8 bg-black/30 p-4">{status}</div> : null}
        {footer ? <div className="border-t border-white/8 pt-4">{footer}</div> : null}
      </div>
    </StudioPanel>
  );
}

export function StudioGenerationStatus({
  accent,
  timing,
  nowMs,
}: {
  accent: CreatorToolAccent;
  timing: GenerationTiming;
  nowMs?: number;
}) {
  const progressClass = {
    blue: 'from-sky-500 to-cyan-400',
    rose: 'from-rose-500 to-fuchsia-400',
    violet: 'from-violet-500 to-fuchsia-500',
    emerald: 'from-emerald-500 to-teal-400',
  }[accent];
  const isComplete = timing.completedInMs !== null;
  const summaryLabel = getGenerationTimingSummaryLabel(timing, nowMs);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm text-zinc-300">
        <span className="flex items-center gap-2 text-zinc-100">
          {isComplete ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
          )}
          {timing.phaseLabel}
        </span>
        {summaryLabel ? <span className="text-zinc-400">{summaryLabel}</span> : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className={clsx('h-full rounded-full bg-gradient-to-r opacity-80', progressClass, isComplete ? '' : 'animate-pulse')} />
      </div>
    </div>
  );
}

export function StudioWorkspacePanel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <StudioPanel className="overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4 sm:px-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            Workspace
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">{title}</h2>
          <p className="mt-1 text-sm text-zinc-400">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </StudioPanel>
  );
}

export function StudioBackgroundProcessingNotice({
  accent,
  label,
  variant = 'summary',
  phaseLabel,
  timingLabel,
}: {
  accent: CreatorToolAccent;
  label: string;
  variant?: 'summary' | 'workspace';
  phaseLabel?: string | null;
  timingLabel?: string | null;
}) {
  const theme = ACCENT_STYLES[accent];
  const isWorkspace = variant === 'workspace';

  return (
    <div
      className={clsx(
        'rounded-[24px] border border-white/8 bg-black/30',
        isWorkspace ? 'flex min-h-[520px] flex-col items-center justify-center p-10 text-center' : 'p-4'
      )}
    >
      <div
        className={clsx(
          'inline-flex items-center justify-center rounded-full border',
          theme.iconWrap,
          isWorkspace ? 'h-16 w-16' : 'h-11 w-11'
        )}
      >
        <Clock3 className={clsx(isWorkspace ? 'h-7 w-7' : 'h-4 w-4')} />
      </div>
      <div className={clsx(isWorkspace ? 'mt-5 max-w-md' : 'mt-3')}>
        <h3 className={clsx('font-semibold text-white', isWorkspace ? 'text-xl' : 'text-sm')}>
          {label.charAt(0).toUpperCase() + label.slice(1)} still processing
        </h3>
        <p className={clsx('mt-2 leading-6 text-zinc-400', isWorkspace ? 'text-sm' : 'text-sm')}>
          This run is taking longer than usual, but it is still active in the background. We&apos;ll keep
          tracking it in{' '}
          <Link href="/creations" className={clsx('underline underline-offset-4 transition hover:text-white', theme.accentText)}>
            My Creations
          </Link>
          .
        </p>
        {phaseLabel || timingLabel ? (
          <div className={clsx('mt-3 rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-left', isWorkspace ? 'mx-auto max-w-sm' : '')}>
            {phaseLabel ? <div className="text-sm font-medium text-zinc-200">{phaseLabel}</div> : null}
            {timingLabel ? <div className="mt-1 text-xs uppercase tracking-[0.18em] text-zinc-500">{timingLabel}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StudioUploadedMediaPreview({
  mediaType,
  src,
  alt,
  onPreview,
  onReplace,
  onRemove,
  fit = 'cover',
  replaceLabel = 'Replace',
  previewHint = 'Preview',
  className,
}: {
  mediaType: StudioMediaPreviewType;
  src: string;
  alt: string;
  onPreview: () => void;
  onReplace: () => void;
  onRemove: () => void;
  fit?: 'cover' | 'contain';
  replaceLabel?: string;
  previewHint?: string;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'relative h-full w-full overflow-hidden rounded-[24px] border border-white/10 bg-black/50',
        className
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        className="group block h-full w-full text-left"
      >
        {mediaType === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt}
            className={clsx('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover')}
          />
        ) : (
          <video
            src={src}
            className={clsx('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover')}
            autoPlay
            loop
            muted
            playsInline
          />
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <div className="pointer-events-none absolute bottom-3 left-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-xs font-semibold text-zinc-100 backdrop-blur-md">
          <Expand className="h-3.5 w-3.5" />
          {previewHint}
        </div>
      </button>

      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReplace();
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/65 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-100 transition hover:bg-black/85"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {replaceLabel}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white transition hover:bg-rose-500/90"
          aria-label={`Remove ${alt}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function StudioMediaPreviewModal({
  isOpen,
  onClose,
  mediaType,
  src,
  alt,
  title,
  footer,
}: {
  isOpen: boolean;
  onClose: () => void;
  mediaType: StudioMediaPreviewType;
  src: string | null;
  alt: string;
  title: string;
  footer?: ReactNode;
}) {
  if (!isOpen || !src) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col gap-6 rounded-[30px] border border-white/10 bg-zinc-900 p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="text-xl font-bold tracking-tight text-white">{title}</h2>

        <div className="flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-[24px] border border-white/5 bg-black/50">
          {mediaType === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={alt} className="max-h-[68vh] w-full object-contain" />
          ) : (
            <video src={src} controls autoPlay loop className="max-h-[68vh] w-full object-contain" />
          )}
        </div>

        {footer ? (
          <div className="rounded-[22px] border border-white/5 bg-black/40 p-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
