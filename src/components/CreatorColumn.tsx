'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Images, LayoutTemplate, SlidersHorizontal, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

import { getCreatorTool, type CreatorToolId } from '@/lib/creator-tools';

/**
 * The creator pages as the app draws them: one column that holds the whole
 * composer (tool tabs, model, prompt, references, and a bar with the settings
 * and Generate), and beside it the result. The column scrolls with the page and
 * its bar stays at the foot of the window; the result stays in view beside it.
 *
 * Built for the image creator first (2026-10-26); video and motion still use
 * `MediaStudioShell` in CreatorStudio.tsx until they move over.
 *
 * The two panes need 1120px of window: the app's sidebar takes 216px of it,
 * which leaves the page about 860px. Below that the result follows the column.
 */
export const CREATOR_TWO_PANE_QUERY = '(min-width: 1120px)';

const MEDIA_TOOL_IDS: CreatorToolId[] = ['image', 'video', 'motion'];

const TOOL_UNDERLINE: Partial<Record<CreatorToolId, string>> = {
  image: 'bg-[var(--ui-accent-image)]',
  video: 'bg-[var(--ui-accent-video)]',
  motion: 'bg-[var(--ui-accent-motion)]',
};

export function CreatorColumnLayout({
  title,
  column,
  canvas,
}: {
  /** The page's heading, for screen readers: the shell's top bar already names the page. */
  title: string;
  column: ReactNode;
  canvas: ReactNode;
}) {
  return (
    // One pane keeps the app's proportions on a tablet rather than stretching the
    // composer across the page.
    <div className="mx-auto grid w-full max-w-[680px] grid-cols-1 gap-4 px-[clamp(1rem,1.9vw,2.25rem)] min-[1120px]:max-w-[1860px] min-[1120px]:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] min-[1120px]:items-start min-[1120px]:gap-5 min-[1440px]:grid-cols-[minmax(380px,440px)_minmax(0,1fr)]">
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-w-0 flex-col gap-3">{column}</div>
      {canvas}
    </div>
  );
}

/** Image, Video and Motion, as the app's tabs: the creator open is underlined in its tool's colour. */
export function CreatorToolTabs({ currentToolId }: { currentToolId: CreatorToolId }) {
  return (
    <nav aria-label="Creator tools" className="flex border-b border-[var(--ui-border-subtle)]">
      {MEDIA_TOOL_IDS.map((toolId) => {
        const tool = getCreatorTool(toolId);
        const isActive = toolId === currentToolId;
        return (
          <Link
            key={toolId}
            href={tool.href}
            prefetch={toolId === 'video' ? false : undefined}
            aria-current={isActive ? 'page' : undefined}
            className={clsx(
              'ui-focus-ring relative flex min-h-12 flex-1 items-center justify-center rounded-t-xl text-sm font-bold transition-colors duration-150',
              isActive
                ? 'text-[var(--ui-text-primary)]'
                : 'text-[var(--ui-text-faint)] hover:text-[var(--ui-text-secondary)]'
            )}
          >
            {tool.shortLabel}
            {isActive ? (
              <span aria-hidden className={clsx('absolute inset-x-5 -bottom-px h-0.5 rounded-full', TOOL_UNDERLINE[toolId])} />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** The model in use, which opens the model picker drawn under it. */
export function CreatorModelChip({
  name,
  badge,
  badgeClassName,
  isOpen,
  onToggle,
}: {
  name: string;
  badge?: string | null;
  /** The badge's gradient, as the model list gives it. */
  badgeClassName?: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      className="ui-focus-ring flex min-h-12 w-full items-center justify-between gap-3 rounded-[18px] border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] px-4 text-left transition-colors duration-150 hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-surface-raised)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-bold text-[var(--ui-text-primary)]">{name}</span>
        {badge ? (
          <span className={clsx('shrink-0 rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-bold text-white', badgeClassName)}>
            {badge}
          </span>
        ) : null}
      </span>
      <ChevronDown
        aria-hidden
        className={clsx('h-4 w-4 shrink-0 text-[var(--ui-text-muted)] transition-transform duration-200', isOpen && 'rotate-180')}
      />
    </button>
  );
}

/** The quiet tile beside Enhance: the templates, as the app's toolbar has them. */
export function CreatorTemplatesTile() {
  return (
    <Link
      href="/templates"
      className="ui-focus-ring flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-3 text-sm font-semibold text-[var(--ui-text-secondary)] transition-colors duration-150 hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)] active:scale-[0.98]"
    >
      <LayoutTemplate aria-hidden className="h-4 w-4 text-[var(--ui-text-muted)]" />
      Templates
    </Link>
  );
}

/**
 * The foot of the column, kept in reach while the column scrolls: above the
 * bottom navigation on a phone, at the window's foot on a laptop. As in the
 * app, the run's settings fold into one chip that reads them back ("1K · AUTO
 * · JPG") and opens them above the bar, and the action beside it says what a
 * run costs. Anything that stops or explains a run (a price that could not be
 * read, a prompt over its limit, the balance) is said just above the bar.
 *
 * The settings are a panel positioned over the column rather than the
 * browser's popover: drawn in the top layer it would need CSS anchor
 * positioning to sit above its chip, which Firefox does not have yet.
 */
export function CreatorColumnBar({
  settingsSummary,
  settings,
  status,
  action,
}: {
  settingsSummary: string;
  /** The controls the chip opens; null where the model has nothing to set. */
  settings: ReactNode | null;
  status?: ReactNode;
  action: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const reducedMotion = useReducedMotion();
  const showsSettings = isOpen && settings !== null;

  useEffect(() => {
    if (!showsSettings) return;
    // A press anywhere but the panel and its chip puts the settings away, as a
    // menu's does: Generate among them, so a run never starts under the panel.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (panelRef.current?.contains(target) || chipRef.current?.contains(target))) return;
      setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      chipRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showsSettings]);

  return (
    <div className="sticky bottom-[calc(var(--app-shell-bottom-nav-space,0px)+0.75rem)] z-30 mt-1">
      <AnimatePresence>
        {showsSettings ? (
          <motion.div
            ref={panelRef}
            key="settings"
            id={panelId}
            role="dialog"
            aria-label="Generation settings"
            initial={reducedMotion ? false : { opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: [0.2, 0, 0, 1] } }}
            exit={reducedMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
            style={{ transformOrigin: 'bottom left' }}
            className="absolute inset-x-0 bottom-full mb-2 max-h-[min(60dvh,32rem)] overflow-y-auto overscroll-contain rounded-[24px] border border-[var(--ui-border-default)] bg-[rgba(20,20,23,0.97)] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl app-scrollbar"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-[var(--ui-text-primary)]">Settings</p>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  chipRef.current?.focus();
                }}
                aria-label="Close settings"
                className="ui-focus-ring -mr-1 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ui-text-muted)] transition-colors hover:bg-white/10 hover:text-[var(--ui-text-primary)]"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>
            {settings}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* One surface for the line and the bar, so nothing scrolling under the
          bar shows between them. */}
      <div className="overflow-hidden rounded-[24px] border border-[var(--ui-border-default)] bg-[rgba(20,20,23,0.95)] shadow-[0_18px_40px_-18px_rgba(0,0,0,0.85)] backdrop-blur-xl">
        {status ? (
          <div className="border-b border-[var(--ui-border-subtle)] px-4 py-3 text-sm">
            {status}
          </div>
        ) : null}

        <div className="flex items-stretch gap-2 p-2">
          {settings !== null ? (
            <button
              ref={chipRef}
              type="button"
              onClick={() => setIsOpen((open) => !open)}
              aria-expanded={showsSettings}
              aria-controls={showsSettings ? panelId : undefined}
              aria-label={`Generation settings: ${settingsSummary}`}
              className="ui-focus-ring flex min-h-12 min-w-0 flex-[0.9] items-center justify-center gap-2 rounded-[18px] bg-[var(--ui-surface-3)] px-3 text-xs font-extrabold text-[var(--ui-text-primary)] transition-[background-color,transform] duration-150 hover:bg-white/[0.11] active:scale-[0.98]"
            >
              <SlidersHorizontal aria-hidden className="h-4 w-4 shrink-0 text-[var(--ui-text-secondary)]" />
              <span data-testid="creator-settings-summary" className="truncate">{settingsSummary}</span>
            </button>
          ) : null}
          <div className="flex min-w-0 flex-[1.2]">{action}</div>
        </div>
      </div>
    </div>
  );
}

/** The bar's primary action: Generate and its price, or what stands in for it. */
export const CREATOR_BAR_PRIMARY_CLASS =
  'ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-[18px] bg-[var(--ui-primary)] px-3 text-[13px] font-extrabold text-[var(--ui-primary-on)] transition-[background-color,transform] duration-150 hover:bg-[var(--ui-primary-strong)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[var(--ui-surface-3)] disabled:text-[var(--ui-text-faint)] disabled:active:scale-100';

/**
 * The result pane. On a wide window it stays in view beside the column for the
 * whole page, so a run's progress and its picture land where the creator is
 * already looking. Under the column it is as tall as what it shows.
 */
export function CreatorCanvas({
  ref,
  title,
  subtitle,
  children,
  footer,
}: {
  ref?: Ref<HTMLElement>;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      ref={ref}
      aria-label="Result"
      className="flex min-w-0 scroll-mt-[calc(var(--app-shell-topbar-height)+1rem)] flex-col overflow-hidden rounded-[28px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] min-[1120px]:sticky min-[1120px]:top-[calc(var(--app-shell-topbar-height)+1rem)] min-[1120px]:h-[calc(100dvh-var(--app-shell-topbar-height)-2rem)]"
    >
      <header className="flex items-start justify-between gap-4 px-5 pt-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-[var(--ui-text-primary)]">{title}</h2>
          {subtitle ? <p className="mt-0.5 line-clamp-1 text-xs text-[var(--ui-text-faint)]">{subtitle}</p> : null}
        </div>
        <Link
          href="/creations"
          className="ui-focus-ring inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--ui-border-subtle)] px-3 text-xs font-semibold text-[var(--ui-text-secondary)] transition-colors duration-150 hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)]"
        >
          Studio
          <Images aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </header>
      {/* Beside the column, a size container, so a frame can take the shape of the
          run's ratio and still fit whichever of its sides is shorter. */}
      <div className="relative flex min-h-64 flex-1 items-center justify-center p-4 sm:p-6 min-[1120px]:min-h-0 min-[1120px]:[container-type:size]">
        {children}
      </div>
      {footer ? <div className="border-t border-[var(--ui-border-subtle)] px-4 py-3 sm:px-6">{footer}</div> : null}
    </section>
  );
}

/** "16:9" → 16/9; "auto" and anything unreadable → null. */
export function parseAspectRatio(aspectRatio: string): number | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

/**
 * A frame in the shape of the run's aspect ratio (square for "auto"), the
 * largest that fits the canvas: where the picture will land. Busy, it glows
 * while the run works; idle, it is the empty state.
 */
export function CreatorCanvasFrame({
  aspectRatio,
  busy = false,
  children,
}: {
  aspectRatio: string;
  busy?: boolean;
  children: ReactNode;
}) {
  const ratio = parseAspectRatio(aspectRatio) ?? 1;
  return (
    <div
      data-testid="creator-canvas-frame"
      style={{ '--creator-frame-ratio': ratio } as CSSProperties}
      className={clsx(
        // Under the column the width decides, short of 70% of the window's height;
        // beside it, the canvas's shorter side.
        'relative flex aspect-[var(--creator-frame-ratio)] w-[min(100%,calc(70dvh*var(--creator-frame-ratio)))] items-center justify-center overflow-hidden rounded-[22px] border min-[1120px]:w-[min(100cqw,calc(100cqh*var(--creator-frame-ratio)))]',
        busy ? 'border-white/10 bg-white/[0.025]' : 'border-dashed border-white/[0.12] bg-white/[0.012]'
      )}
    >
      {busy ? (
        <div aria-hidden className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_50%_40%,rgba(115,191,242,0.12),transparent_65%)] motion-reduce:animate-none" />
      ) : null}
      <div className="relative flex max-w-xs flex-col items-center gap-3 px-6 text-center">{children}</div>
    </div>
  );
}
