import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Expand, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

import {
  getAccentClasses,
  IconButton,
  Kicker,
  MediaFrame,
  Pill,
  SectionHeader,
  Surface,
  Text,
} from '@/app/components/DesignSystem';
import {
  CREATOR_TOOLS,
  type CreatorToolAccent,
  type CreatorToolDefinition,
  type CreatorToolId,
  getCreatorTool,
} from '@/lib/creator-tools';
import {
  getGenerationTimingCountdownLabel,
  getGenerationTimingProgressPercent,
  getGenerationTimingSummaryLabel,
  type GenerationTiming,
} from '@/lib/generation-timing';

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
    <SectionHeader
      eyebrow={eyebrow}
      title={title}
      description={description}
      actionHref={actionHref}
      actionLabel={actionLabel}
      actionIcon={ArrowRight}
      compact={isMinimal}
      className={isMinimal ? 'mb-4' : 'mb-6'}
    />
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
  const theme = getAccentClasses(tool.accent);
  const Icon = tool.icon;
  const isLaunchpad = variant === 'launchpad';
  const prefetch = tool.id === 'workflow' || tool.id === 'video' ? false : undefined;

  return (
    <Link
      href={tool.href}
      prefetch={prefetch}
      className={clsx(
        'ui-card ui-card-interactive ui-focus-ring group relative block h-full cursor-pointer overflow-hidden bg-[var(--ui-surface-1)]',
        theme.border,
        theme.focusRing,
        isLaunchpad
          ? 'min-h-[318px] rounded-3xl p-4 sm:p-5'
          : 'min-h-[286px] rounded-3xl p-3.5 sm:p-4'
      )}
    >
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <article className="flex h-full flex-col">
        <MediaFrame className={clsx('relative', isLaunchpad ? 'rounded-3xl' : 'rounded-2xl')}>
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
          <Kicker className="pointer-events-none absolute bottom-4 left-4 text-white/85">
            {tool.shortLabel}
          </Kicker>
        </MediaFrame>

        <div className="mt-4 flex items-start justify-between gap-3">
          <div>
            <Kicker className="text-zinc-500">{tool.eyebrow}</Kicker>
            <Text
              as="h3"
              variant="cardTitle"
              className={clsx('mt-2', isLaunchpad ? 'text-2xl leading-8' : 'text-xl')}
            >
              {tool.label}
            </Text>
          </div>
          <Pill accent={tool.accent} className="shrink-0">{tool.badge}</Pill>
        </div>

        <Text variant="bodySm" className="mt-3 max-w-[28ch] text-zinc-300">{tool.summary}</Text>

        <div className="mt-auto pt-4">
          <div
            className={clsx(
              'ui-button w-full justify-between',
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

function GeneratorQuickSwitch({
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
  const theme = getAccentClasses(tool.accent);

  return (
    <Surface as="section" variant="panel" padding="none" className="ui-enter mb-6 p-5 sm:p-6">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <IconButton href={backHref} label="Back to create hub" icon={ArrowLeft} className="shrink-0" />
            <div className="max-w-2xl">
              <Kicker className="text-zinc-500">{eyebrow}</Kicker>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Text as="h1" variant="pageTitle" className="text-3xl sm:text-4xl">
                  {title}
                </Text>
                <Pill accent={tool.accent}>{tool.badge}</Pill>
              </div>
              <Text variant="bodySm" className="mt-3 max-w-2xl sm:text-base">{description}</Text>
            </div>
          </div>

          {credits !== null ? (
            <div className="inline-flex min-h-11 items-center gap-2 self-start rounded-full border border-amber-300/20 bg-amber-400/10 px-4 text-sm font-bold text-amber-100">
              <Sparkles className={clsx('h-4 w-4', theme.accentText)} />
              <span>{credits}</span>
              <span className="text-zinc-500">credits</span>
            </div>
          ) : null}
        </div>

        {showPathSwitcher ? (
          <Surface variant="soft" padding="sm" className="space-y-3 bg-black/30">
            <Kicker className="text-zinc-500">Switch creator path</Kicker>
            <GeneratorQuickSwitch currentToolId={currentToolId} />
          </Surface>
        ) : null}
      </div>
    </Surface>
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
    <Surface as="section" variant="panel" padding="none" className={className}>
      {children}
    </Surface>
  );
}

function MediaStudioRail({
  currentToolId,
}: {
  currentToolId: CreatorToolId;
}) {
  return (
    <aside className="hidden lg:flex lg:flex-col lg:gap-3">
      <StudioPanel className="sticky top-24 p-3">
        <Link
          href="/create"
          className="ui-focus-ring mb-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[20px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Hub
        </Link>

        <div className="flex flex-col gap-2">
          {MEDIA_TOOL_IDS.map((toolId) => {
            const tool = getCreatorTool(toolId);
            const Icon = tool.icon;
            const theme = getAccentClasses(tool.accent);
            const isActive = tool.id === currentToolId;

            return (
              <Link
                key={tool.id}
                href={tool.href}
                prefetch={tool.id === 'video' ? false : undefined}
                className={clsx(
                  'ui-focus-ring group flex min-h-24 flex-col items-center gap-2 rounded-[24px] border px-3 py-4 text-center transition',
                  isActive
                    ? 'border-[rgba(255,122,89,0.28)] bg-[var(--ui-primary-soft)] text-[var(--ui-text-primary)]'
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
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--ui-text-faint)]">
            Run summary
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">{title}</h2>
        </div>
        <div>{summary}</div>
        {details ? <div className="rounded-[22px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-4">{details}</div> : null}
        <div>{action}</div>
        {status ? <div className="rounded-[22px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-4">{status}</div> : null}
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
    amber: 'from-amber-500 to-orange-400',
  }[accent];
  const isComplete = timing.completedInMs !== null;
  const summaryLabel = getGenerationTimingSummaryLabel(timing, nowMs);
  const countdownLabel = getGenerationTimingCountdownLabel(timing, nowMs);
  const progressPercent = getGenerationTimingProgressPercent(timing, nowMs);

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
        {countdownLabel || summaryLabel ? (
          <span className="text-right text-zinc-400">
            <span className={countdownLabel ? 'text-zinc-100' : undefined}>
              {countdownLabel ?? summaryLabel}
            </span>
            {countdownLabel && summaryLabel ? (
              <span className="mt-0.5 block text-xs text-zinc-500">{summaryLabel}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={clsx('h-full rounded-full bg-gradient-to-r opacity-80', progressClass, isComplete ? '' : 'animate-pulse')}
          style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
        />
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
      <div className="flex items-start justify-between gap-4 border-b border-[var(--ui-border-subtle)] px-5 py-4 sm:px-6">
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
  const theme = getAccentClasses(accent);
  const isWorkspace = variant === 'workspace';

  return (
    <div
      className={clsx(
        'rounded-[24px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)]',
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
            Studio
          </Link>
          .
        </p>
        {phaseLabel || timingLabel ? (
          <div className={clsx('mt-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-4 py-3 text-left', isWorkspace ? 'mx-auto max-w-sm' : '')}>
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
          className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-rose-500/90"
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
  if (!isOpen || !src || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="preview-modal-overlay fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="preview-modal-panel relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col gap-4 overflow-y-auto overscroll-contain rounded-[28px] border border-white/10 bg-zinc-900 p-4 shadow-2xl sm:max-h-[90dvh] sm:gap-6 sm:rounded-[30px] sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition hover:bg-zinc-800 hover:text-white sm:h-10 sm:w-10"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="pr-10 text-lg font-bold tracking-tight text-white sm:pr-12 sm:text-xl">{title}</h2>

        <div className="preview-modal-media flex min-h-[220px] shrink-0 items-center justify-center overflow-hidden rounded-[20px] border border-white/5 bg-black/50 sm:min-h-[320px] sm:flex-1 sm:rounded-[24px]">
          {mediaType === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={alt} className="preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]" />
          ) : (
            <video src={src} controls autoPlay loop className="preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]" />
          )}
        </div>

        {footer ? (
          <div className="rounded-[20px] border border-white/5 bg-black/40 p-4 sm:rounded-[22px]">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
