'use client';

import Link from 'next/link';
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Images, LayoutTemplate, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

import { MEDIA_TOOL_IDS } from '@/components/CreatorStudio';
import { getAccentClasses, IconButton, Text, type UiAccent } from '@/components/DesignSystem';
import { getCreatorTool, type CreatorToolId } from '@/lib/creator-tools';

/**
 * The creator pages as the app draws them: one column that holds the whole
 * composer (tool tabs, model, prompt, references, and a bar with the settings
 * and Generate), and beside it the result. The column scrolls with the page and
 * its bar stays at the foot of the window; the result stays in view beside it.
 *
 * Built for the image creator (2026-10-26), then carried to video and motion:
 * the three creators share it.
 *
 * The two panes need 1120px of window: the app's sidebar takes 216px of it,
 * which leaves the page about 860px. Below that the result follows the column,
 * at most 680px wide, so a tablet keeps the app's proportions.
 */
export function CreatorColumnLayout({
  title,
  column,
  canvas,
}: {
  /** The page's heading, for screen readers: the shell's top bar says "Create" and the tool tab names the creator. */
  title: string;
  column: ReactNode;
  canvas: ReactNode;
}) {
  return (
    // Its own stacking context: the model picker's layer 50 stays under the
    // shell's top bar (also 50) when the page scrolls.
    <div className="relative z-10 mx-auto grid w-full max-w-[680px] grid-cols-1 gap-4 px-[clamp(1rem,1.9vw,2.25rem)] min-[1120px]:max-w-[1860px] min-[1120px]:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] min-[1120px]:items-start min-[1120px]:gap-5 min-[1440px]:grid-cols-[minmax(380px,440px)_minmax(0,1fr)]">
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-w-0 flex-col gap-3" onFocus={keepFocusClearOfBar}>{column}</div>
      {canvas}
    </div>
  );
}

/**
 * A control focused under the column's sticky bar is in the window by the
 * browser's measure, so nothing scrolls it out from under the bar: a keyboard
 * walk through the reference rows went on behind it. This scrolls the page by
 * what the bar covers.
 */
function keepFocusClearOfBar(event: FocusEvent<HTMLDivElement>) {
  const target = event.target;
  const bar = event.currentTarget.querySelector('[data-creator-bar]');
  if (!(target instanceof HTMLElement) || !bar || bar.contains(target)) return;
  const barBox = bar.getBoundingClientRect();
  if (barBox.height === 0) return;
  const { bottom } = target.getBoundingClientRect();
  if (bottom > barBox.top - 8) window.scrollBy({ top: bottom - barBox.top + 16 });
}

/** Image, Video and Motion, as the app's tabs: the creator open is underlined in its tool's accent. */
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
              <span aria-hidden className={clsx('absolute inset-x-5 -bottom-px h-0.5 rounded-full', getAccentClasses(tool.accent).indicator)} />
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
      className="ui-focus-ring flex min-h-12 w-full items-center justify-between gap-3 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] px-4 text-left transition-colors duration-150 hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-surface-raised)]"
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

/**
 * The balance beside the model chip on a phone. The shell's own balance pill is
 * hidden below 640px, and the creators were the page that showed it there.
 */
export function CreatorPhoneBalance({ credits }: { credits: number | null }) {
  return (
    <Link
      href="/pricing"
      prefetch={false}
      className="ui-focus-ring inline-flex min-h-12 shrink-0 items-center gap-1.5 rounded-full border border-amber-300/20 bg-amber-400/10 px-3 text-sm font-bold text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-400/15 sm:hidden"
    >
      <Sparkles aria-hidden className="h-4 w-4" />
      {typeof credits === 'number' ? `${credits} credits` : 'Credits'}
    </Link>
  );
}

/** The quiet tile beside Enhance: the templates, as the app's toolbar has them. */
export function CreatorTemplatesTile() {
  return (
    <Link
      href="/templates"
      // On screen at every load, and most visits never open it: no prefetch of its page.
      prefetch={false}
      className="ui-focus-ring flex min-h-12 items-center justify-center gap-2 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-3 text-sm font-semibold text-[var(--ui-text-secondary)] transition-colors duration-150 hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)] active:scale-[0.98]"
    >
      <LayoutTemplate aria-hidden className="h-4 w-4 text-[var(--ui-text-muted)]" />
      Templates
    </Link>
  );
}

const CHOICE_COLUMNS = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' } as const;

/**
 * The bar and its settings float over the column, so their fill is opaque:
 * `.ui-surface` is a page panel's, 94% opaque, and with no blur behind it the
 * column's words showed through the settings.
 */
const FLOATING_SURFACE_CLASS =
  'rounded-ui-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] shadow-ui-panel';

/**
 * One setting with a single value (aspect ratio, resolution, quality): a radio
 * group, so a screen reader hears which one is chosen, and the arrow keys move
 * the choice as they do in any radio group.
 */
export function CreatorSettingChoices<T extends string>({
  label,
  labelHidden = false,
  hint,
  options,
  optionLabel,
  value,
  onChange,
  columns,
  accent = 'image',
  capitalize = false,
}: {
  label: string;
  /** For a group whose options say what it is, as the shot mode's do. */
  labelHidden?: boolean;
  hint?: string;
  options: readonly T[];
  /** What an option says, where its value is not words ("std" → "Standard 720p"). */
  optionLabel?: (option: T) => string;
  value: T;
  onChange: (value: T) => void;
  columns: keyof typeof CHOICE_COLUMNS;
  accent?: UiAccent;
  capitalize?: boolean;
}) {
  const labelId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.indexOf(value);
  const selectedClasses = getAccentClasses(accent).selected;

  const choose = (index: number) => {
    const next = (index + options.length) % options.length;
    onChange(options[next]);
    optionRefs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    choose(moves[event.key]);
  };

  return (
    <div>
      {labelHidden ? (
        <p id={labelId} className="sr-only">{label}</p>
      ) : (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p id={labelId} className="text-xs font-bold text-[var(--ui-text-muted)]">{label}</p>
          {hint ? <p className="text-xs text-[var(--ui-text-faint)]">{hint}</p> : null}
        </div>
      )}
      <div role="radiogroup" aria-labelledby={labelId} className={clsx('grid gap-1.5', CHOICE_COLUMNS[columns])}>
        {options.map((option, index) => {
          const checked = index === selectedIndex;
          return (
            <button
              key={option}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // One stop in the tab order, on the chosen option (the first while none is).
              tabIndex={checked || (selectedIndex === -1 && index === 0) ? 0 : -1}
              onClick={() => onChange(option)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={clsx(
                'ui-focus-ring min-h-10 rounded-ui-md border px-2 text-xs font-bold transition-colors duration-150',
                capitalize && 'capitalize',
                checked
                  ? selectedClasses
                  : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-secondary)]'
              )}
            >
              {optionLabel ? optionLabel(option) : option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One setting that is on or off (Google Search grounding, a fixed lens, AI sound): a
 * switch that says what it does under its name.
 */
export function CreatorSettingSwitch({
  label,
  description,
  checked,
  onChange,
  accent = 'image',
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  accent?: UiAccent;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="ui-focus-ring flex w-full items-center justify-between gap-4 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] px-4 py-3 text-left transition-colors hover:bg-[var(--ui-surface-2)]"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[var(--ui-text-primary)]">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-[var(--ui-text-muted)]">{description}</span> : null}
      </span>
      <span
        aria-hidden
        className={clsx(
          'flex h-6 w-11 shrink-0 items-center rounded-full p-1 transition-colors',
          checked ? getAccentClasses(accent).indicator : 'bg-[var(--ui-border-strong)]'
        )}
      >
        <span className={clsx('h-4 w-4 rounded-full bg-white shadow-md transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
      </span>
    </button>
  );
}

/**
 * The foot of the column, kept in reach while the column scrolls: above the
 * bottom navigation on a phone, at the window's foot on a laptop. As in the
 * app, the run's settings fold into one chip that reads them back ("1K · AUTO
 * · JPG") and opens them above the bar, and the action beside it says what a
 * run costs. Anything that stops or explains a run (a price that could not be
 * read, a prompt over its limit, the balance) is said just above the buttons.
 *
 * The settings are a panel positioned over the column rather than the
 * browser's popover: drawn in the top layer it would need CSS anchor
 * positioning to sit above its chip, which Firefox does not have yet. It takes
 * the focus when it opens, comes after the bar in the tab order, and closes on
 * Escape inside it, when the focus leaves it, or at a press anywhere but itself
 * and its chip, Generate included, so a run never starts under it.
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
  const barRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const reducedMotion = useReducedMotion();
  const showsSettings = isOpen && settings !== null;

  const closeSettings = (returnFocus: boolean) => {
    setIsOpen(false);
    if (returnFocus) chipRef.current?.focus();
  };

  useEffect(() => {
    if (!showsSettings) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (panelRef.current?.contains(target) || chipRef.current?.contains(target))) return;
      setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showsSettings]);

  // Opened, the panel takes the focus, and its height is what the window has
  // between the top bar and this bar: on a short phone a fixed cap put its top
  // under the top bar, where its first rows could not be reached. It fits again
  // whenever the bar's height changes, as when a line about the price arrives
  // over the buttons while it is open, and never takes more than that room: on
  // a window too short for its rows it scrolls rather than slide under the top bar.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!showsSettings || !bar) return;
    const fit = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const header = document.querySelector('.app-shell-header');
      const ceiling = header ? header.getBoundingClientRect().bottom : 0;
      const room = bar.getBoundingClientRect().top - ceiling - 16;
      panel.style.maxHeight = `${Math.max(0, Math.min(room, 512))}px`;
    };
    fit();
    panelRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', fit);
    const barSize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    barSize?.observe(bar);
    return () => {
      window.removeEventListener('resize', fit);
      barSize?.disconnect();
    };
  }, [showsSettings]);

  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !showsSettings) return;
    event.preventDefault();
    closeSettings(true);
  };

  return (
    <div ref={barRef} data-creator-bar className="sticky bottom-[calc(var(--app-shell-bottom-nav-space,0px)+0.75rem)] z-30 mt-1">
      {/* One surface for the line and the bar, so nothing scrolling under the
          bar shows between them, and opaque, so nothing needs blurring behind it. */}
      <div className={clsx(FLOATING_SURFACE_CLASS, 'overflow-hidden')}>
        {status ? (
          <div data-creator-bar-status className="border-b border-[var(--ui-border-subtle)] px-4 py-3 text-sm">
            {status}
          </div>
        ) : null}

        <div className="flex items-stretch gap-2 p-2">
          {settings !== null ? (
            <button
              ref={chipRef}
              type="button"
              onClick={() => setIsOpen((open) => !open)}
              onKeyDown={onEscape}
              aria-expanded={showsSettings}
              aria-controls={showsSettings ? panelId : undefined}
              aria-label={`Generation settings: ${settingsSummary}`}
              className="ui-focus-ring flex min-h-12 min-w-0 flex-[0.9] items-center justify-center gap-2 rounded-full bg-[var(--ui-surface-2)] px-3 text-xs font-extrabold text-[var(--ui-text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--ui-surface-3)] active:scale-[0.98]"
            >
              <SlidersHorizontal aria-hidden className="h-4 w-4 shrink-0 text-[var(--ui-text-secondary)]" />
              <span data-testid="creator-settings-summary" className="truncate">{settingsSummary}</span>
            </button>
          ) : null}
          <div className="flex min-w-0 flex-[1.2]">{action}</div>
        </div>
      </div>

      <AnimatePresence>
        {showsSettings ? (
          <motion.div
            ref={panelRef}
            key="settings"
            id={panelId}
            role="dialog"
            aria-label="Generation settings"
            tabIndex={-1}
            onKeyDown={onEscape}
            onBlur={(event) => {
              // Tabbing out puts it away; a press elsewhere is the pointerdown listener's.
              const next = event.relatedTarget;
              if (!(next instanceof Node)) return;
              if (panelRef.current?.contains(next) || chipRef.current?.contains(next)) return;
              setIsOpen(false);
            }}
            initial={reducedMotion ? false : { opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, pointerEvents: 'auto', transition: { duration: 0.18, ease: [0.2, 0, 0, 1] } }}
            // Closed, it takes no press while it fades.
            exit={reducedMotion
              ? { opacity: 0, pointerEvents: 'none', transition: { duration: 0 } }
              : { opacity: 0, y: 4, scale: 0.98, pointerEvents: 'none', transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
            style={{ transformOrigin: 'bottom left' }}
            className={clsx(
              FLOATING_SURFACE_CLASS,
              'app-scrollbar absolute inset-x-0 bottom-full mb-2 max-h-[min(60dvh,32rem)] overflow-y-auto overscroll-contain p-4 outline-none'
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-[var(--ui-text-primary)]">Settings</p>
              <IconButton label="Close settings" icon={X} onClick={() => closeSettings(true)} className="-mr-1" />
            </div>
            {settings}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The bar's primary action: Generate and its price, or what stands in for it. */
export const CREATOR_BAR_PRIMARY_CLASS =
  'ui-focus-ring flex min-h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[var(--ui-primary)] px-3 text-sm font-extrabold text-[var(--ui-primary-on)] transition-[background-color,transform] duration-150 hover:bg-[var(--ui-primary-strong)] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-[var(--ui-surface-3)] disabled:text-[var(--ui-text-faint)] disabled:active:scale-100';

/**
 * The result pane. On a wide window it stays in view beside the column for the
 * whole page, so a run's progress and its picture land where the creator is
 * already looking. Under the column it is as tall as what it shows, and taller
 * while it shows a result, so the picture arriving does not move what follows.
 *
 * `revealKey` brings it into view when it changes, if it is out of view: the
 * page bumps it once a run the creator started is under way, so a refusal,
 * which the bar says, never scrolls the bar away.
 */
export function CreatorCanvas({
  title,
  subtitle,
  revealKey = 0,
  tall = false,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  revealKey?: number;
  tall?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!revealKey) return;
    const section = sectionRef.current;
    if (!section) return;
    // Beside the column its top is near the window's; under it, below the bar.
    const { top } = section.getBoundingClientRect();
    if (top >= 0 && top <= window.innerHeight * 0.4) return;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, [revealKey]);

  return (
    <section
      ref={sectionRef}
      aria-label="Result"
      // Beside the column it fills what the page leaves under the top bar, its
      // padding (1.5rem from 640px) above and below, so a short page never scrolls.
      className="flex min-w-0 scroll-mt-[calc(var(--app-shell-topbar-height)+1rem)] flex-col overflow-hidden rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] min-[1120px]:sticky min-[1120px]:top-[calc(var(--app-shell-topbar-height)+1.5rem)] min-[1120px]:h-[calc(100dvh-var(--app-shell-topbar-height)-3rem)]"
    >
      <header className="flex items-start justify-between gap-4 px-5 pt-4 sm:px-6">
        <div className="min-w-0">
          <Text as="h2" variant="label">{title}</Text>
          {subtitle ? <Text variant="caption" className="mt-0.5 line-clamp-1">{subtitle}</Text> : null}
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
          run's ratio and still fit whichever of its sides is shorter; a picture
          fits the stage there, and 70% of the window's height under the column. */}
      <div
        className={clsx(
          'relative flex flex-1 items-center justify-center p-4 sm:p-6 [&_img]:max-h-[70dvh] min-[1120px]:min-h-0 min-[1120px]:[container-type:size] min-[1120px]:[&_img]:max-h-full',
          tall ? 'min-h-[min(70dvh,40rem)]' : 'min-h-64'
        )}
      >
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
 * The narrowest and widest a frame is drawn. The models offer 8:1 and 1:8,
 * which at the exact ratio left a 40px strip that cut the frame's own words;
 * between these the frame still reads as tall or wide.
 */
export const CANVAS_FRAME_RATIO_LIMITS = { min: 0.45, max: 2.4 } as const;

/** The frame's sizing, shared with the result's box so a clip lands where its frame was. */
const CANVAS_FRAME_SIZE_CLASS =
  // Under the column the width decides, short of 70% of the window's height;
  // beside it, the canvas's shorter side.
  'aspect-[var(--creator-frame-ratio)] w-[min(100%,calc(70dvh*var(--creator-frame-ratio)))] min-[1120px]:w-[min(100cqw,calc(100cqh*var(--creator-frame-ratio)))]';

function clampedFrameRatio(aspectRatio: string, fallback = 1) {
  return Math.min(
    CANVAS_FRAME_RATIO_LIMITS.max,
    Math.max(CANVAS_FRAME_RATIO_LIMITS.min, parseAspectRatio(aspectRatio) ?? fallback),
  );
}

/**
 * A finished clip, as large as the canvas allows, on black: in the shape it was
 * asked for (16:9 for "auto") until the clip's own size is known, then in that.
 * A motion run takes its shape from its reference, which the page does not
 * measure, and a model can answer "auto" with any shape.
 */
export function CreatorCanvasMedia({ aspectRatio, children }: { aspectRatio: string; children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [clipRatio, setClipRatio] = useState<number | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // `loadedmetadata` does not bubble, so it is heard on the way down instead.
    const readClip = (event: Event) => {
      const clip = event.target;
      if (clip instanceof HTMLVideoElement && clip.videoWidth > 0 && clip.videoHeight > 0) {
        setClipRatio(clip.videoWidth / clip.videoHeight);
      }
    };
    box.addEventListener('loadedmetadata', readClip, true);
    return () => box.removeEventListener('loadedmetadata', readClip, true);
  }, []);

  const ratio = clipRatio === null
    ? clampedFrameRatio(aspectRatio, 16 / 9)
    : Math.min(CANVAS_FRAME_RATIO_LIMITS.max, Math.max(CANVAS_FRAME_RATIO_LIMITS.min, clipRatio));
  return (
    <div
      ref={boxRef}
      data-testid="creator-canvas-media"
      style={{ '--creator-frame-ratio': ratio } as CSSProperties}
      className={clsx('relative overflow-hidden rounded-ui-xl bg-black', CANVAS_FRAME_SIZE_CLASS)}
    >
      {children}
    </div>
  );
}

/**
 * A frame in the shape of the run's aspect ratio (square for "auto"), the
 * largest that fits the canvas: where the picture will land. Busy, it glows in
 * the tool's accent while the run works; idle, it is the empty state.
 */
export function CreatorCanvasFrame({
  aspectRatio,
  accent = 'image',
  busy = false,
  children,
}: {
  aspectRatio: string;
  accent?: UiAccent;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="creator-canvas-frame"
      style={{ '--creator-frame-ratio': clampedFrameRatio(aspectRatio) } as CSSProperties}
      className={clsx(
        'relative flex items-center justify-center overflow-hidden rounded-ui-xl border',
        CANVAS_FRAME_SIZE_CLASS,
        busy ? 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]' : 'border-dashed border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)]'
      )}
    >
      {busy ? (
        <div aria-hidden className={clsx('absolute inset-0 animate-pulse bg-gradient-to-b motion-reduce:animate-none', getAccentClasses(accent).surface)} />
      ) : null}
      <div className="relative flex max-w-xs flex-col items-center gap-3 px-6 text-center">{children}</div>
    </div>
  );
}
