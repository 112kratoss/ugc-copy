import InlineMediaVideo from '@/components/InlineMediaVideo';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight, CheckCircle2, Clock3, Expand, Loader2, RefreshCw, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

import {
  getAccentClasses,
  Kicker,
  MediaFrame,
  Pill,
  SectionHeader,
  Surface,
  Text,
} from '@/components/DesignSystem';
import {
  type CreatorToolAccent,
  type CreatorToolDefinition,
  type CreatorToolId,
} from '@/lib/creator-tools';
import {
  getGenerationTimingCountdownLabel,
  getGenerationTimingProgressPercent,
  getGenerationTimingSummaryLabel,
  type GenerationTiming,
} from '@/lib/generation-timing';

export const MEDIA_TOOL_IDS: CreatorToolId[] = ['image', 'video', 'motion'];
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
  preview?: ReactNode;
  /** A ready-made setup to start the tool from, offered under its launch link. */
  starter?: { title: string; href: string };
}

export function CreatorToolCard({
  tool,
  preview,
  starter,
}: CreatorToolCardProps) {
  const theme = getAccentClasses(tool.accent);
  const Icon = tool.icon;
  const prefetch = tool.id === 'workflow' || tool.id === 'video' ? false : undefined;

  // One link opens the tool from anywhere on the card, title, summary and call
  // to action in it; a ready-made setup is a second link in the card's foot,
  // beside that one rather than inside it. The card draws the launch link's
  // focus ring (`.creator-tool-card` in globals.css): the link fills it, and
  // the card's overflow would clip a ring the link drew itself.
  return (
    <div
      className={clsx(
        'creator-tool-card ui-card ui-card-interactive group relative flex h-full min-h-[318px] flex-col overflow-hidden rounded-3xl bg-[var(--ui-surface-1)]',
        theme.border
      )}
    >
      <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <Link
        href={tool.href}
        prefetch={prefetch}
        className="group flex flex-1 cursor-pointer flex-col rounded-3xl p-4 outline-none sm:p-5"
      >
        <article className="flex h-full flex-col">
          <MediaFrame className="relative rounded-3xl">
            {preview ? (
              <div className="h-44 w-full bg-black sm:h-48">
                {preview}
              </div>
            ) : (
              <div
                className={clsx(
                  'relative h-44 w-full bg-gradient-to-br sm:h-48',
                  theme.surface
                )}
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.12),transparent_35%)]" />
                <div className="absolute inset-0 bg-[linear-gradient(145deg,transparent_0%,rgba(255,255,255,0.04)_52%,transparent_100%)] opacity-70" />
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
            <div
              className={clsx(
                'pointer-events-none absolute left-4 top-4 flex h-12 w-12 items-center justify-center rounded-2xl border backdrop-blur-sm',
                theme.iconWrap
              )}
            >
              <Icon className="h-5 w-5" />
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
                className="mt-2 text-2xl leading-8"
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
      {starter ? (
        <div className="border-t border-[var(--ui-border-subtle)] px-4 py-1 sm:px-5">
          <Link
            href={starter.href}
            prefetch={prefetch}
            className="ui-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-full text-sm font-semibold text-zinc-400 transition hover:text-white"
          >
            <span className="text-zinc-500">Try:</span>{' '}
            {starter.title}
            <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </Link>
        </div>
      ) : null}
    </div>
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

function StudioNoticeCard({
  icon: Icon,
  label,
  description,
  action,
  onDismiss,
  dismissLabel = 'Dismiss notice',
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  // The action sits under the text at every width: in the creators' column (340-440px)
  // a row from 640px left the text about 50px beside the buttons.
  return (
    <StudioPanel className="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--ui-primary)]/25 bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--ui-primary-strong)]">
              {label}
            </div>
            <p className="mt-1 text-sm text-zinc-300">{description}</p>
          </div>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              className="ui-focus-ring -mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
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
  return <StudioNoticeCard icon={Sparkles} label={label} description={description} action={action} />;
}

/**
 * The creators' model notices: the selected model was retired or replaced,
 * unsupported settings were reset, or the model list failed to load. Same card
 * as StudioRemixNotice with a title of its own, because these show on any
 * creator page, not only on remixes. Pass onDismiss for a one-off change; leave
 * it off for a problem that clears itself once fixed, such as a retired model.
 */
export function StudioModelNotice({
  description,
  onDismiss,
}: {
  description: string;
  onDismiss?: () => void;
}) {
  return (
    <StudioNoticeCard
      icon={SlidersHorizontal}
      label="Model settings"
      description={description}
      onDismiss={onDismiss}
      dismissLabel="Dismiss model notice"
    />
  );
}

/**
 * Occupies the same slot as StudioRemixNotice while /api/remix-source is still
 * resolving. Without it the studio paints its default empty form immediately,
 * which reads as finished rather than loading — and the restored prompt then
 * lands on top of whatever the creator had started typing in the meantime.
 */
export function StudioRemixHydrationNotice({
  label = 'Remixing Community Creation',
  description = 'Restoring the original prompt, settings, and references…',
}: {
  label?: string;
  description?: string;
}) {
  return (
    <StudioPanel className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--ui-primary)]/25 bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--ui-primary-strong)]">
            {label}
          </div>
          <p className="mt-1 text-sm text-zinc-300" role="status" aria-live="polite">
            {description}
          </p>
        </div>
      </div>
    </StudioPanel>
  );
}

/**
 * The run's price could not be read: Generate waits for one, and this asks again. A creator
 * page draws it alone, or under a start's refusal when the price asked again since (after
 * `cost_changed`, say) could not be read either.
 */
export function StudioQuoteRetry({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <p className="text-sm text-amber-300">{message}<button type="button" onClick={onRetry} className="ml-2 underline underline-offset-2 hover:text-amber-100">Retry quote</button></p>
  );
}

/**
 * The page and the start price this run apart, and asking again did not move the price
 * (`useCreatorQuote`'s `pageOutOfDate`): only a reload onto the current build ends it, so a
 * creator page draws this in place of the start's refusal while Generate waits. A remix
 * keeps no draft and is restored from its original again; any other page saves its draft
 * before it reloads. When the last such reload brought this same build back
 * (`reloadBroughtBackThisBuild`: a page served stale), the same reload would only bring it
 * back again, so the notice says so and offers none.
 */
export function StudioOutOfDatePageNotice({ isRemix, reloadDidNotHelp, onReload }: {
  isRemix: boolean;
  reloadDidNotHelp: boolean;
  onReload: () => void;
}) {
  if (reloadDidNotHelp) {
    return (
      <p role="alert" className="text-sm text-amber-300">
        This page is out of date, so it cannot show what this run costs, and reloading it brought back the same version. Wait a few minutes, then reload the page.
        {isRemix ? ' The remix starts again from the original.' : ''}
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-amber-300">
      This page is out of date, so it cannot show what this run costs. Reload it to see the current price.
      {isRemix ? ' The remix starts again from the original.' : ' Your draft is kept.'}
      <button type="button" onClick={onReload} className="ml-2 underline underline-offset-2 hover:text-amber-100">Reload page</button>
    </p>
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
    rose: 'from-rose-500 to-orange-400',
    violet: 'from-[var(--ui-primary)] to-[#ff9b7f]',
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

export function StudioBackgroundProcessingNotice({
  accent,
  label,
  phaseLabel,
  timingLabel,
}: {
  accent: CreatorToolAccent;
  label: string;
  phaseLabel?: string | null;
  timingLabel?: string | null;
}) {
  const theme = getAccentClasses(accent);

  return (
    <div className="rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-4">
      <div className={clsx('inline-flex h-11 w-11 items-center justify-center rounded-full border', theme.iconWrap)}>
        <Clock3 className="h-4 w-4" />
      </div>
      <div className="mt-3">
        <h3 className="text-sm font-semibold text-[var(--ui-text-primary)]">
          {label.charAt(0).toUpperCase() + label.slice(1)} still processing
        </h3>
        <p className="mt-2 text-sm leading-6 text-[var(--ui-text-muted)]">
          This run is taking longer than usual, but it is still active in the background. We&apos;ll keep
          tracking it in{' '}
          <Link href="/creations" className={clsx('underline underline-offset-4 transition hover:text-[var(--ui-text-primary)]', theme.accentText)}>
            Studio
          </Link>
          .
        </p>
        {phaseLabel || timingLabel ? (
          <div className="mt-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-4 py-3 text-left">
            {phaseLabel ? <div className="text-sm font-medium text-[var(--ui-text-secondary)]">{phaseLabel}</div> : null}
            {timingLabel ? <div className="mt-1 text-xs text-[var(--ui-text-muted)]">{timingLabel}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A reference's @handle, shown whole however narrow its card is.
 *
 * A handle is one run of letters, digits and underscores, and a browser never
 * breaks a line inside such a run. The reference cards are 160px wide on a
 * desktop, so a clipped handle read "@im…", which hid the one thing the card
 * asks the creator to type. The handle may break after an underscore first,
 * and anywhere only when one stretch is still too long. The breaks are <wbr>,
 * which adds no character, so a handle copied off the page still matches.
 * The lines are balanced, so a handle a few pixels too wide reads "@video_"
 * then "element_2" and does not leave the 2 on a line of its own.
 */
export function StudioElementHandle({
  handle,
  className,
}: {
  handle: string;
  className?: string;
}) {
  const segments = handle.split('_');

  return (
    <span className={clsx('min-w-0 text-balance [overflow-wrap:anywhere]', className)}>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {index < segments.length - 1 ? `${segment}_` : segment}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The chip that puts a reference's @handle into a prompt: its name, then the handle.
 *
 * A chip could not shrink below its text, and a handle cannot break, so a long
 * name made the chip wider than its row: 425px in a 308px row for a name of 34
 * characters, which made the whole page 466px wide on a 390px phone. The chip
 * stops at its row now (max-w-full). The handle is the part the prompt needs,
 * so it keeps its full width and the name is cut to what is left. That order
 * is what flex-1 is for: the name starts from no width and takes only the room
 * the handle does not use. Were both merely allowed to shrink, they would
 * shrink together, and the handle would wrap beside a name that still had
 * room to give. A handle wider than the row by itself wraps the way it does
 * on a reference card.
 */
export function StudioElementChip({
  displayName,
  handle,
  handleClassName,
  onInsert,
}: {
  displayName: string;
  handle: string;
  handleClassName?: string;
  onInsert: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onInsert}
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-left text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
    >
      <span className="min-w-0 flex-1 truncate text-zinc-400">{displayName}</span>
      <StudioElementHandle handle={handle} className={handleClassName} />
    </button>
  );
}

/**
 * The @handles a sentence names, as "@one, @two".
 *
 * In running text a handle is one word that cannot break, so a long one ran
 * out of its sentence: "Unknown element mention: @..." stood 181px past its
 * row on a 390px phone for a handle of 68 characters. Here each handle is a
 * box of its own, no wider than the sentence. It moves to the next line whole
 * while a line can hold it, and breaks the way StudioElementHandle does only
 * when none can. The comma is inside the box of the handle before it, because
 * a browser will start a line with a comma that follows such a box.
 */
export function StudioElementHandleList({ handles }: { handles: string[] }) {
  return (
    <>
      {handles.map((handle, index) => (
        <Fragment key={handle}>
          {index > 0 ? ' ' : null}
          <StudioElementHandle
            handle={index < handles.length - 1 ? `${handle},` : handle}
            className="inline-block max-w-full"
          />
        </Fragment>
      ))}
    </>
  );
}

/** A word that holds an @handle, with whatever is written against it: "@red_jacket,". */
const HANDLE_WORD = /(?:^|\W)@\w/;

/**
 * A sentence held as one string that may name @handles, such as a creator bar's
 * error, which the page or the server may have written.
 *
 * Printed as plain text, a handle in such a sentence could not break. "Unknown
 * element mention: @..." in the video creator's run panel (now its column's bar) stood 149px past its
 * box in a 1280px window for a handle of 68 characters, and 219px on a 390px
 * phone, where the page scrolled 165px sideways. The sentence is split at its
 * spaces here, and a word that holds a handle gets the box
 * StudioElementHandleList gives one: it moves to the next line whole while a
 * line can hold it, and breaks after an underscore only when none can. A comma
 * or full stop written against a handle is part of its word, so it is inside
 * the box, as the list's commas are. Every other word stays the text it was.
 */
export function StudioElementHandleText({ text }: { text: string }) {
  const pieces: Array<{ text: string; holdsHandle: boolean }> = [];
  // Words and the white space between them, in turn.
  for (const part of text.split(/(\s+)/)) {
    const holdsHandle = HANDLE_WORD.test(part);
    const last = pieces[pieces.length - 1];
    if (!holdsHandle && last && !last.holdsHandle) {
      last.text += part;
    } else if (part) {
      pieces.push({ text: part, holdsHandle });
    }
  }

  return (
    <>
      {pieces.map((piece, index) => (
        piece.holdsHandle ? (
          <StudioElementHandle key={index} handle={piece.text} className="inline-block max-w-full" />
        ) : piece.text
      ))}
    </>
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
        'relative h-full w-full overflow-hidden rounded-ui-xl border border-[var(--ui-border-default)] bg-black',
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
          <InlineMediaVideo
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

      {/* Two round buttons, so they fit a slot half a creator's column wide (about 150px
          on a phone or beside the canvas), where a worded Replace ran into Remove. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReplace();
          }}
          aria-label={`${replaceLabel} ${alt}`}
          title={replaceLabel}
          className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-white transition hover:bg-black/90"
        >
          <RefreshCw className="h-4 w-4" />
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
            <InlineMediaVideo src={src} controls autoPlay loop className="preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]" />
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
