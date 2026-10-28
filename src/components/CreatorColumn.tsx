'use client';

import Link from 'next/link';
import type { ComponentPropsWithRef, CSSProperties, DragEvent, FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, CircleAlert, Images, Info, LayoutTemplate, Loader2, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

import {
  MEDIA_TOOL_IDS,
  StudioElementChip,
  StudioElementHandle,
  StudioUploadedMediaPreview,
  type StudioMediaPreviewType,
} from '@/components/CreatorStudio';
import { getAccentClasses, IconButton, type UiAccent } from '@/components/DesignSystem';
import type { CreatorCanvasPhase } from '@/lib/creator-canvas-phase';
import { getCreatorTool, type CreatorToolId } from '@/lib/creator-tools';
import { PRICING_PLANS } from '@/lib/pricing';
import type { OptionPrice } from '@/lib/use-quote-prices';

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
  resultFirst = false,
}: {
  /** The page's heading, for screen readers: the shell's top bar says "Create" and the tool tab names the creator. */
  title: string;
  column: ReactNode;
  canvas: ReactNode;
  /**
   * Under the column's width the result comes first while a run is done (the artboard
   * Result at 390): what was made, and posting it, before the next prompt.
   */
  resultFirst?: boolean;
}) {
  return (
    // Its own stacking context: the model picker's layer 50 stays under the
    // shell's top bar (also 50) when the page scrolls.
    <div
      className={clsx(
        'relative z-10 mx-auto grid w-full max-w-[680px] grid-cols-1 gap-4 px-[clamp(1rem,1.9vw,2.25rem)] min-[1120px]:max-w-[1860px] min-[1120px]:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] min-[1120px]:items-start min-[1120px]:gap-5 min-[1440px]:grid-cols-[minmax(380px,440px)_minmax(0,1fr)]',
        resultFirst && 'max-[1119px]:[&>section]:order-first',
      )}
    >
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
 * what the bar covers, for the keyboard's focus only: a press focuses its
 * control on the way down, and the scroll moved it from under the pointer before
 * the press ended, so a suggestion pressed just above the bar never got its
 * click (2026-10-26). A text field shows its focus either way, and is still
 * scrolled clear to be typed in.
 */
function keepFocusClearOfBar(event: FocusEvent<HTMLDivElement>) {
  const target = event.target;
  const bar = event.currentTarget.querySelector('[data-creator-bar]');
  if (!(target instanceof HTMLElement) || !bar || bar.contains(target) || !showsFocus(target)) return;
  const barBox = bar.getBoundingClientRect();
  if (barBox.height === 0) return;
  const { bottom } = target.getBoundingClientRect();
  if (bottom > barBox.top - 8) window.scrollBy({ top: bottom - barBox.top + 16 });
}

/** Whether the browser draws this focus (the keyboard's, or a text field's); a browser without `:focus-visible` says yes. */
function showsFocus(element: HTMLElement) {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
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
  optionPrice,
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
  /**
   * What the run costs with each option, under it: "19", or "23 · +1" in amber past the
   * balance, with the words a screen reader says ("23 credits, 1 more than your balance";
   * `optionPricesOf`); null where it is not known yet. An option past the balance stays
   * selectable: the bar offers a top-up in Generate's place.
   */
  optionPrice?: (option: T) => OptionPrice | null;
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
          const price = optionPrice?.(option) ?? null;
          const text = optionLabel ? optionLabel(option) : option;
          return (
            <button
              key={option}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // One name for the option and its price: read from two pieces, browsers
              // joined them differently ("4s , 16 credits").
              aria-label={price ? `${text}, ${price.spoken}` : undefined}
              // One stop in the tab order, on the chosen option (the first while none is).
              tabIndex={checked || (selectedIndex === -1 && index === 0) ? 0 : -1}
              onClick={() => onChange(option)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={clsx(
                'ui-focus-ring min-h-10 rounded-ui-md border px-2 text-xs font-bold transition-colors duration-150',
                optionPrice && 'flex min-h-12 flex-col items-center justify-center gap-0.5 py-1',
                capitalize && 'capitalize',
                checked
                  ? selectedClasses
                  : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-secondary)]'
              )}
            >
              <span>{text}</span>
              {price ? (
                <span
                  data-testid="creator-option-price"
                  className={clsx('text-[11px] font-semibold tabular-nums', price.over !== null ? 'text-amber-300' : 'text-[var(--ui-text-faint)]')}
                >
                  {price.text}
                </span>
              ) : null}
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
  settingsSummaryShort,
  settings,
  settingsFootNote,
  settingsOpen,
  onSettingsOpenChange,
  status,
  narrowStatus,
  action,
  note,
  stacked = false,
  holdsFootUnderColumn = true,
}: {
  settingsSummary: string;
  /** What the chip keeps of the summary where it is narrow ("480P · 5s"); the summary is its name either way. */
  settingsSummaryShort?: string;
  /** The controls the chip opens; null where the model has nothing to set. */
  settings: ReactNode | null;
  /** At the foot of the open settings, beside Done: what the run costs as set ("This run 19 credits · leaves 3"). */
  settingsFootNote?: ReactNode;
  /** Whether the settings are open, where the page keeps it: it prices their options only while they show. */
  settingsOpen?: boolean;
  /** Told when the settings open and close. */
  onSettingsOpenChange?: (open: boolean) => void;
  status?: ReactNode;
  /** Over the buttons under the column only, where the canvas may be out of view (`CreatorRunFailedLine`). */
  narrowStatus?: ReactNode;
  action: ReactNode;
  /** A quiet line under the buttons: the balance and what the run leaves of it, or what signing up gives a visitor. */
  note?: ReactNode;
  /** The action's words need the bar's width ("Switch back to Seedance 2 Mini"): the chip goes above it at every width. */
  stacked?: boolean;
  /**
   * Under the column's width the bar keeps to the window's foot. Off while a done run's
   * publish bar holds it there (the artboard Result at 390): the bar then waits at the
   * column's end, so the two never stack.
   */
  holdsFootUnderColumn?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = settingsOpen ?? ownOpen;
  const setIsOpen = useCallback((open: boolean) => {
    setOwnOpen(open);
    onSettingsOpenChange?.(open);
  }, [onSettingsOpenChange]);
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
  }, [setIsOpen, showsSettings]);

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
    <div
      ref={barRef}
      data-creator-bar
      className={clsx('sticky bottom-[calc(var(--app-shell-bottom-nav-space,0px)+0.75rem)] z-30 mt-1', !holdsFootUnderColumn && 'max-[1119px]:static')}
    >
      {/* One surface for the line and the bar, so nothing scrolling under the
          bar shows between them, and opaque, so nothing needs blurring behind it. */}
      <div className={clsx(FLOATING_SURFACE_CLASS, 'overflow-hidden')}>
        {status ? (
          <div data-creator-bar-status className="border-b border-[var(--ui-border-subtle)] px-4 py-3 text-sm">
            {status}
          </div>
        ) : null}
        {narrowStatus ? (
          <div data-creator-bar-narrow-status className="border-b border-[var(--ui-border-subtle)] px-4 py-3 text-sm min-[1120px]:hidden">
            {narrowStatus}
          </div>
        ) : null}

        {/* Beside the result (two panes) the chip has a row of its own, so the whole
            summary fits; in one column it shares the row with Generate, and on a
            phone it keeps the resolution and length. */}
        <div className={clsx('flex items-stretch gap-2 p-2', stacked ? 'flex-col' : 'min-[1120px]:flex-col')}>
          {settings !== null ? (
            <button
              ref={chipRef}
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              onKeyDown={onEscape}
              aria-expanded={showsSettings}
              aria-controls={showsSettings ? panelId : undefined}
              aria-label={`Generation settings: ${settingsSummary}`}
              className={clsx(
                'ui-focus-ring flex min-h-12 min-w-0 flex-[0.9] items-center justify-center gap-2 rounded-full px-3 text-xs font-extrabold text-[var(--ui-text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--ui-surface-3)] active:scale-[0.98]',
                stacked ? 'flex-none' : 'min-[1120px]:flex-none',
                showsSettings ? 'bg-[var(--ui-surface-3)]' : 'bg-[var(--ui-surface-2)]',
              )}
            >
              <SlidersHorizontal aria-hidden className="h-4 w-4 shrink-0 text-[var(--ui-text-secondary)]" />
              <span
                data-testid="creator-settings-summary"
                className={clsx('truncate', settingsSummaryShort && 'max-sm:hidden')}
              >
                {settingsSummary}
              </span>
              {settingsSummaryShort ? (
                <span aria-hidden className="truncate sm:hidden">{settingsSummaryShort}</span>
              ) : null}
              <ChevronDown
                aria-hidden
                className={clsx('h-4 w-4 shrink-0 text-[var(--ui-text-muted)] transition-transform duration-200', !showsSettings && 'rotate-180')}
              />
            </button>
          ) : null}
          <div className={clsx('flex min-w-0 flex-[1.2]', stacked ? 'flex-none' : 'min-[1120px]:flex-none')}>{action}</div>
        </div>
        {note ? (
          <div data-creator-bar-note className="px-4 pb-3 text-xs leading-5 text-[var(--ui-text-muted)]">
            {note}
          </div>
        ) : null}
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
            {settingsFootNote !== undefined ? (
              // Held at the foot of the panel while its options scroll, as the artboard has it.
              <div className="sticky -bottom-4 -mx-4 -mb-4 mt-4 flex items-center justify-between gap-3 border-t border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-4 py-3 text-sm text-[var(--ui-text-secondary)]">
                <div aria-live="polite" className="min-w-0">{settingsFootNote}</div>
                <button
                  type="button"
                  onClick={() => closeSettings(true)}
                  className="ui-button ui-button-secondary ui-focus-ring min-h-11 shrink-0 px-4"
                >
                  Done
                </button>
              </div>
            ) : null}
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
 * The bar's primary action. An unanswered start is checked again before
 * anything new is sent; a short balance offers a top-up; otherwise Generate,
 * named with its price while its face says why it waits ("Calculating...").
 * A run under way keeps Generate's place, spinning: the balance it left can be
 * short of the next run's price, and a top-up in its place read as if the run
 * had been refused.
 */
export function CreatorBarAction({
  awaitingCheck,
  onCheckAgain,
  showTopUp,
  isGenerating,
  disabled,
  costLabel,
  hasPrice,
  onGenerate,
  signUp = false,
}: {
  awaitingCheck: boolean;
  onCheckAgain: () => void;
  showTopUp: boolean;
  isGenerating: boolean;
  disabled: boolean;
  costLabel: string;
  hasPrice: boolean;
  onGenerate: () => void;
  /**
   * Signed out: the press checks the form as Generate does, then asks the
   * visitor to sign up. Its face says so; the price is in the line under the bar.
   */
  signUp?: boolean;
}) {
  if (signUp) {
    return (
      <button type="button" onClick={onGenerate} disabled={disabled} className={CREATOR_BAR_PRIMARY_CLASS}>
        Sign up to generate
      </button>
    );
  }
  if (awaitingCheck) {
    return (
      <button type="button" onClick={onCheckAgain} className={CREATOR_BAR_PRIMARY_CLASS}>
        Check again
      </button>
    );
  }
  if (showTopUp && !isGenerating) {
    return (
      <Link href="/pricing" className={CREATOR_BAR_PRIMARY_CLASS}>
        <Sparkles aria-hidden className="h-4 w-4" />
        Top Up Credits
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onGenerate}
      disabled={disabled || isGenerating}
      // The price stays in its name while the face says why it waits.
      aria-label={isGenerating ? undefined : `Generate · ${costLabel}`}
      className={CREATOR_BAR_PRIMARY_CLASS}
    >
      {isGenerating ? (
        <><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Generating...</>
      ) : hasPrice ? (
        `Generate · ${costLabel}`
      ) : (
        // As the app's bar: until there is a price the button says why it waits,
        // and the line above says more.
        <span className="truncate">{costLabel}</span>
      )}
    </button>
  );
}

/** The empty canvas's line for a signed-out visitor: nothing is lost by setting up first. */
export const CREATOR_VISITOR_CANVAS_HINT = 'Set everything up first. When you sign up, your prompt, settings and images stay.';

/** Under a signed-out visitor's bar: what a new account starts with, and what this run takes of it. */
export function CreatorVisitorNote({ welcomeCredits, cost }: { welcomeCredits: number | null; cost: number | null }) {
  const strong = 'font-bold text-[var(--ui-text-secondary)]';
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
      <span>
        {welcomeCredits !== null
          ? <>New accounts get <strong className={strong}>{welcomeCredits} free credits</strong></>
          : 'Sign in with Google to generate'}
      </span>
      {cost !== null ? (
        <span>
          This run <strong className={strong}>{cost}</strong>
          {welcomeCredits !== null && cost <= welcomeCredits ? ` · leaves ${welcomeCredits - cost}` : null}
        </span>
      ) : null}
    </div>
  );
}

/** Over the bar while the balance is short of the run's price, or the server said so. */
export function CreatorTopUpNotice({ cost, balance, message }: {
  cost: number | null;
  balance: number | null;
  /** The server's refusal, where it refused a start the balance on screen allowed. */
  message: string | null;
}) {
  return (
    <div>
      <p className="font-semibold text-[var(--ui-text-primary)]">Not enough credits</p>
      <p className="mt-1 text-[var(--ui-text-muted)]">
        {cost !== null && balance !== null && balance < cost ? (
          <>This run costs <strong className="text-[var(--ui-text-primary)]">{cost} credits</strong> but you only have <strong className="text-[var(--ui-text-primary)]">{balance}</strong>.</>
        ) : message}
      </p>
    </div>
  );
}

/** "1 credit", "19 credits". */
export function creditsWords(count: number): string {
  return `${count} ${count === 1 ? 'credit' : 'credits'}`;
}

/** The smallest credit pack, as a top-up names it: "500 credits for ₹415", or "500 for ₹415" `short`. */
export function smallestCreditPackLabel({ short = false }: { short?: boolean } = {}): string {
  const pack = PRICING_PLANS.reduce((smallest, plan) => (plan.credits < smallest.credits ? plan : smallest));
  const credits = pack.credits.toLocaleString('en-IN');
  return `${short ? credits : `${credits} credits`} for ₹${pack.priceInr.toLocaleString('en-IN')}`;
}

const NOTE_STRONG_CLASS = 'font-bold text-[var(--ui-text-secondary)]';

/** A link in the line under the bar: the words' size, its press area the 44px of a control. */
export const CREATOR_NOTE_LINK_CLASS =
  "ui-focus-ring relative rounded-sm font-semibold text-[var(--ui-text-secondary)] underline underline-offset-4 after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] hover:text-[var(--ui-text-primary)]";

/** Under a signed-in creator's bar: the balance, and what this run leaves of it ("Balance 22 · leaves 3"). */
export function CreatorBalanceNote({ balance, cost }: { balance: number; cost: number | null }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
      <span>Balance <strong className={NOTE_STRONG_CLASS}>{balance}</strong></span>
      {cost !== null && cost <= balance ? (
        <span>Leaves <strong className={NOTE_STRONG_CLASS}>{balance - cost}</strong></span>
      ) : null}
    </div>
  );
}

/**
 * At the foot of the open settings, beside Done (owner, 2026-10-28): what the run costs as
 * set and what it leaves of the balance ("This run 19 credits · leaves 6"), or how far past
 * it the run is. A visitor's is read against the welcome credits.
 */
export function CreatorSettingsFootNote({ cost, costLabel, balance, isVisitor }: {
  /** The run's price; null while it is not known, when `costLabel` says why. */
  cost: number | null;
  costLabel: string;
  balance: number | null;
  isVisitor: boolean;
}) {
  if (cost === null) return <span>{costLabel}</span>;
  return (
    <span>
      This run <strong className="text-[var(--ui-text-primary)]">{creditsWords(cost)}</strong>
      {balance === null
        ? null
        : cost <= balance
          ? ` · leaves ${balance - cost}`
          : ` · ${cost - balance} more than ${isVisitor ? 'the free credits' : 'your balance'}`}
    </span>
  );
}

/**
 * Under the settings while an option shown costs more than the balance: what "+N" means
 * (the least such N), and that those options can still be chosen.
 */
export function CreatorOverBalanceLegend({ over, balance, isVisitor, offersTopUp }: {
  over: number | null;
  balance: number | null;
  isVisitor: boolean;
  /** Such an option puts Top up in Generate's place (not where the bar offers something else, or for a visitor). */
  offersTopUp: boolean;
}) {
  if (over === null || balance === null) return null;
  return (
    <p className="text-xs leading-5 text-[var(--ui-text-faint)]">
      “+{over}” means {creditsWords(over)} more than {isVisitor ? `the ${balance} free credits` : `your balance of ${balance}`}.
      {offersTopUp ? ' Those options stay selectable, and show Top up in place of Generate.' : ' Those options stay selectable.'}
    </p>
  );
}

/**
 * In Generate's place while the balance is short of every video model's run (owner,
 * 2026-10-28): an image first, on the image model that costs least, with the prompt.
 */
export function CreatorMakeImageInstead({ href, fromCost }: { href: string; fromCost: number }) {
  return (
    <Link href={href} className={CREATOR_BAR_PRIMARY_CLASS}>
      <span className="truncate">{`Make an image instead · from ${creditsWords(fromCost)}`}</span>
    </Link>
  );
}

/** Under that bar: the balance, where videos start, and a top-up second. */
export function CreatorLowBalanceNote({ balance, videosFrom }: { balance: number; videosFrom: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span>Balance <strong className={NOTE_STRONG_CLASS}>{balance}</strong> · videos from {videosFrom}</span>
      <Link href="/pricing" className={CREATOR_NOTE_LINK_CLASS}>
        Top up: {smallestCreditPackLabel({ short: true })}
      </Link>
    </div>
  );
}

/** Over the column while the balance is short of every video: what it does cover. */
export function CreatorLowBalanceNotice({ balance, videosFrom, image }: {
  balance: number;
  videosFrom: number;
  /** The image model that costs least, and its price; null while unknown. */
  image: { name: string; cost: number } | null;
}) {
  const coversImage = image !== null && image.cost <= balance;
  return (
    <div role="status" className="rounded-ui-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-4">
      <p className="text-sm font-bold text-[var(--ui-text-primary)]">
        {creditsWords(balance)}{coversImage ? ': enough for images' : ''}
      </p>
      <p className="mt-1 text-sm text-[var(--ui-text-muted)]">
        Videos start at {creditsWords(videosFrom)}.
        {image ? ` ${image.name} makes a picture for ${image.cost}, and you can turn a picture into a video later.` : ''}
      </p>
    </div>
  );
}

/**
 * Over the bar on a remix moved back to its original model when the balance is short
 * of it: what the original needs, and what the run fitted to the balance would cost.
 */
export function CreatorFitNotice({ original, balance, fitted }: {
  original: { name: string; cost: number };
  balance: number;
  fitted: { name: string; cost: number; keeps: string };
}) {
  const strong = 'font-bold text-[var(--ui-text-primary)]';
  return (
    <p className="text-[var(--ui-text-secondary)]">
      {original.name} needs <strong className={strong}>{creditsWords(original.cost)}</strong>; you have <strong className={strong}>{balance}</strong>.
      {' '}{fitted.name} runs {fitted.keeps} for <strong className={strong}>{fitted.cost}</strong>.
    </p>
  );
}

/**
 * A start that got no answer: it may have started. Check again (the bar's
 * action) asks under the same key; this offers a new run instead, priced, since
 * it can be a second one.
 */
export function CreatorPendingStartNotice({ message, costLabel, hasPrice, disabled, onStartNew }: {
  message: string;
  costLabel: string;
  hasPrice: boolean;
  disabled: boolean;
  onStartNew: () => void;
}) {
  return (
    <div className="space-y-3">
      <p role="alert" className="text-amber-200">{message}</p>
      <button
        type="button"
        onClick={onStartNew}
        disabled={disabled}
        className="ui-button ui-button-secondary ui-focus-ring w-full disabled:cursor-not-allowed disabled:opacity-50"
      >
        {hasPrice ? `Start a new run · ${costLabel}` : 'Start a new run'}
      </button>
    </div>
  );
}

/** A run the page stopped following, named beside Generate: it still finishes. */
export function CreatorBackgroundRunLine({ title }: { title: string }) {
  return (
    <p className="text-[var(--ui-text-secondary)]">
      {title}: it lands in{' '}
      <Link href="/creations" className="underline underline-offset-4 hover:text-[var(--ui-text-primary)]">Studio</Link>
      {' '}when it is done.
    </p>
  );
}

export type CreatorMentionSuggestion = { id: string; displayName: string; handle: string };

/**
 * The panel that typing "@" in a prompt opens: what was typed, and the
 * references whose handle it can become. A group named by its title.
 */
export function CreatorMentionPanel<T extends CreatorMentionSuggestion>({
  title,
  hint,
  query,
  suggestions,
  handleClassName,
  onInsert,
}: {
  title: string;
  hint: string;
  query: string;
  suggestions: readonly T[];
  /** A suggestion's handle colour: on the video creator a clip's differs from a picture's. */
  handleClassName: (suggestion: T) => string;
  onInsert: (handle: string) => void;
}) {
  return (
    <div role="group" aria-label={title} className="rounded-ui-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-[min(50%_-_0.75rem,10rem)] flex-1">
          <p className="ui-kicker">{title}</p>
          <p className="mt-1 text-sm text-[var(--ui-text-muted)]">{hint}</p>
        </div>
        {query ? (
          <StudioElementHandle
            handle={`@${query}`}
            className="rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 py-1 text-xs font-semibold text-[var(--ui-text-secondary)]"
          />
        ) : null}
      </div>
      {suggestions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <StudioElementChip
              key={suggestion.id}
              displayName={suggestion.displayName}
              handle={suggestion.handle}
              handleClassName={handleClassName(suggestion)}
              onInsert={() => onInsert(suggestion.handle)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A small pill action on a reference: Insert, Copy, Add video. */
export const CREATOR_REFERENCE_CHIP_CLASS =
  'ui-focus-ring inline-flex min-h-9 shrink-0 items-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 text-xs font-semibold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-surface-3)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * A reference in a creator's column, as a row: its picture or clip (which
 * opens a preview), its name to rename it by, Remove, and its @handle with
 * Insert (and Copy for a Kling clip), each named for the handle it acts on.
 */
export function CreatorReferenceRow({
  accent,
  preview,
  displayName,
  nameDraft,
  placeholder,
  onNameChange,
  onNameCommit,
  onNameCancel,
  onRemove,
  handle,
  handleClassName,
  onInsert,
  onCopy,
  note,
}: {
  accent: UiAccent;
  /** The picture or clip at the row's start. */
  preview: ReactNode;
  displayName: string;
  /** The name as it is being typed, if it is. */
  nameDraft: string | undefined;
  placeholder: string;
  onNameChange: (value: string) => void;
  /** The typed name becomes the reference's, and the handle and the prompt follow it. */
  onNameCommit: () => void;
  onNameCancel: () => void;
  onRemove: () => void;
  handle: string;
  handleClassName: string;
  onInsert: () => void;
  onCopy?: () => void;
  note?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-2.5">
      {preview}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={nameDraft ?? displayName}
            onChange={(event) => onNameChange(event.target.value)}
            onBlur={onNameCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onNameCommit();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                onNameCancel();
                event.currentTarget.blur();
              }
            }}
            aria-label={`Name of ${displayName}`}
            placeholder={placeholder}
            className={clsx(
              'min-w-0 flex-1 rounded-ui-sm border border-transparent bg-transparent px-2 py-1.5 text-sm font-semibold text-[var(--ui-text-primary)] outline-none transition-colors hover:border-[var(--ui-border-default)] focus:bg-[var(--ui-surface-2)]',
              getAccentClasses(accent).fieldFocus
            )}
          />
          <IconButton label={`Remove ${displayName}`} icon={X} onClick={onRemove} className="shrink-0" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
          <StudioElementHandle handle={handle} className={clsx('text-xs font-semibold', handleClassName)} />
          <div className="flex flex-wrap items-center gap-1.5">
            {onCopy ? (
              <button type="button" onClick={onCopy} aria-label={`Copy ${handle}`} className={CREATOR_REFERENCE_CHIP_CLASS}>
                Copy
              </button>
            ) : null}
            <button type="button" onClick={onInsert} aria-label={`Insert ${handle}`} className={CREATOR_REFERENCE_CHIP_CLASS}>
              Insert
            </button>
          </div>
        </div>
        {note ? <p className="px-2 text-xs text-[var(--ui-text-faint)]">{note}</p> : null}
      </div>
    </li>
  );
}

/** A round, dashed control in the column that adds files in the tool's accent. */
function addTileClass(accent: UiAccent, dragging: boolean) {
  const classes = getAccentClasses(accent);
  return clsx(
    'flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-dashed px-4 text-sm font-semibold transition-colors duration-150',
    // The file field's keyboard focus draws the shared ring on the tile.
    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)]',
    dragging ? clsx(classes.tileActive, 'text-[var(--ui-text-primary)]') : clsx(classes.tile, 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]')
  );
}

type FileInputProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'className'>;
type FileDropProps = {
  dragging: boolean;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
};

/** A tile that adds files: a label around its file field, which a drop on it also takes. */
export function CreatorAddTile({
  accent,
  icon: Icon,
  label,
  input,
  dragging,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  accent: UiAccent;
  icon: LucideIcon;
  label: ReactNode;
  input: FileInputProps;
} & FileDropProps) {
  return (
    <label className={addTileClass(accent, dragging)} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <Icon aria-hidden className={clsx('h-4 w-4', getAccentClasses(accent).mark)} />
      {label}
      <input type="file" className="sr-only" {...input} />
    </label>
  );
}

/** The same in the shape of a button, for one that adds something other than a file (a shot). */
export function creatorAddButtonClass(accent: UiAccent) {
  return clsx('ui-focus-ring disabled:cursor-not-allowed disabled:opacity-50', addTileClass(accent, false));
}

/**
 * One input of fixed role (a start frame, the character image, the reference
 * video): empty, a dashed tile to add it; filled, its preview with Replace and
 * Remove. One file field serves both: the tile's label is for it, and Replace
 * clicks it.
 */
export function CreatorUploadSlot({
  accent,
  title,
  hint,
  status,
  height,
  mediaType,
  src,
  alt,
  previewHint,
  fit = 'cover',
  icon: Icon,
  emptyLabel,
  emptyHint,
  input,
  onPreview,
  onRemove,
  dragging,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  accent: UiAccent;
  title: string;
  hint?: string;
  /** "required" or "optional", beside the title. */
  status?: string;
  height: 'frame' | 'tall';
  mediaType: StudioMediaPreviewType;
  src: string | null;
  alt: string;
  previewHint: string;
  fit?: 'cover' | 'contain';
  icon: LucideIcon;
  emptyLabel: string;
  emptyHint?: string;
  /** The file field; give it an `id`, which the tile's label points at. Replace clicks it. */
  input: Omit<FileInputProps, 'ref'> & { id: string };
  onPreview: () => void;
  onRemove: () => void;
} & FileDropProps) {
  const classes = getAccentClasses(accent);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <h3 className="flex items-baseline justify-between gap-2 text-xs font-semibold text-[var(--ui-text-secondary)]">
        {title}
        {status ? <span className="font-normal text-[var(--ui-text-faint)]">{status}</span> : null}
      </h3>
      {hint ? <p className="text-xs text-[var(--ui-text-faint)]">{hint}</p> : null}
      <div className={clsx('relative mt-2', height === 'tall' ? 'h-[180px]' : 'h-[140px]')}>
        {/* Before the tile, so the tile can draw the field's keyboard focus (peer). */}
        <input type="file" {...input} ref={inputRef} className={src ? 'hidden' : 'peer sr-only'} />
        {src ? (
          <StudioUploadedMediaPreview
            mediaType={mediaType}
            src={src}
            alt={alt}
            fit={fit}
            previewHint={previewHint}
            onPreview={onPreview}
            onReplace={() => inputRef.current?.click()}
            onRemove={onRemove}
          />
        ) : (
          <label
            htmlFor={input.id}
            className={clsx(
              'flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-ui-xl border border-dashed px-3 text-center transition-colors duration-150',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ui-focus)]/55 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--ui-bg-app)]',
              'peer-disabled:cursor-not-allowed',
              dragging
                ? clsx(classes.tileActive, 'text-[var(--ui-text-primary)]')
                : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)]'
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <Icon aria-hidden className={clsx('h-5 w-5', dragging && classes.mark)} />
            <span className="text-xs font-semibold">{emptyLabel}</span>
            {emptyHint ? <span className="text-xs text-[var(--ui-text-faint)]">{emptyHint}</span> : null}
          </label>
        )}
      </div>
    </div>
  );
}

/**
 * Whether a run's end may take the focus to the canvas's heading: from the page itself, the
 * canvas or the bar, where a run is started and tried again. A creator at work in the column
 * meanwhile (typing the next prompt, picking a model) keeps it, as does one in a dialog (the
 * settings, which would close without it) or under one that holds the page (a preview).
 */
function movesFocusAtRunEnd(active: Element | null, canvas: Element | null): boolean {
  if (document.querySelector('[aria-modal="true"]')) return false;
  if (!active || active === document.body) return true;
  if (active.closest('[role="dialog"]')) return false;
  return Boolean(canvas?.contains(active) || active.closest('[data-creator-bar]'));
}

/**
 * The result pane. On a wide window it stays in view beside the column for the
 * whole page, so a run's progress and its picture land where the creator is
 * already looking. Under the column it is as tall as what it shows, and taller
 * while it shows a result, so the picture arriving does not move what follows.
 *
 * `revealKey` brings it into view when it changes, if it is out of view: the
 * page bumps it once a run the creator started is under way, so a refusal,
 * which the bar says, never scrolls the bar away.
 *
 * `focusKey` moves the focus to its heading when it changes (the build notes:
 * focus moves to "Done" when a run ends): the page bumps it when a run the
 * creator started here ends, done or failed, never for a run picked up on load,
 * which leaves the page where it is, and for the bar's "See why". A creator at
 * work in the column or a dialog keeps the focus (`movesFocusAtRunEnd`).
 *
 * `flow` stacks the body instead of fitting one thing to it (the empty canvas's
 * posts, a run at work and the posts under it): beside the column it scrolls
 * within the pane, and the frame takes a `CreatorCanvasStage` of its own.
 */
export function CreatorCanvas({
  title,
  chip,
  revealKey = 0,
  focusKey = 0,
  flow = false,
  showStudioLink = true,
  children,
}: {
  title: string;
  /** The run's line beside the title: "Seedance 2 Mini · 480P · 9:16 · 5s · 19 credits". */
  chip?: string | null;
  revealKey?: number;
  focusKey?: number;
  flow?: boolean;
  /** Off for a signed-out visitor: Studio holds an account's creations. */
  showStudioLink?: boolean;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  useEffect(() => {
    if (!focusKey || !movesFocusAtRunEnd(document.activeElement, sectionRef.current)) return;
    // The browser brings the heading into view as it focuses it where it is out of view
    // (under the column on a phone), and beside the column it is in view already.
    headingRef.current?.focus();
  }, [focusKey]);

  return (
    <section
      ref={sectionRef}
      aria-label="Result"
      // Beside the column it fills what the page leaves under the top bar, its
      // padding (1.5rem from 640px) above and below, so a short page never scrolls.
      className="flex min-w-0 scroll-mt-[calc(var(--app-shell-topbar-height)+1rem)] flex-col overflow-hidden rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] min-[1120px]:sticky min-[1120px]:top-[calc(var(--app-shell-topbar-height)+1.5rem)] min-[1120px]:h-[calc(100dvh-var(--app-shell-topbar-height)-3rem)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 sm:px-6">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="ui-focus-ring rounded-sm text-base font-bold leading-6 text-[var(--ui-text-primary)] outline-none sm:text-lg"
        >
          {title}
        </h2>
        {showStudioLink ? (
          <Link
            href="/creations"
            className="ui-focus-ring order-2 ml-auto inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--ui-border-subtle)] px-3 text-xs font-semibold text-[var(--ui-text-secondary)] transition-colors duration-150 hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)] sm:order-3"
          >
            Studio
            <Images aria-hidden className="h-3.5 w-3.5" />
          </Link>
        ) : null}
        {chip ? (
          // Beside the title where it fits; under it, on a row of its own, on a phone.
          <span className="order-3 max-sm:basis-full sm:order-2 sm:min-w-0">
            <span
              data-testid="creator-canvas-chip"
              className="inline-block max-w-full rounded-full border border-[var(--ui-border-default)] px-3 py-1 text-xs font-semibold text-[var(--ui-text-secondary)] [overflow-wrap:anywhere]"
            >
              {chip}
            </span>
          </span>
        ) : null}
      </header>
      {/* Beside the column, a size container, so a frame can take the shape of the
          run's ratio and still fit whichever of its sides is shorter; a picture
          fits the stage there, and 70% of the window's height under the column. */}
      {/* A flowing body's padding is a variable: the publish form's sticky Publish takes it back
          to sit on the pane's edge (`CreatorPublishPanel`). */}
      <div
        className={clsx(
          flow
            ? 'app-scrollbar relative flex flex-1 flex-col gap-5 p-[var(--creator-canvas-padding)] [--creator-canvas-padding:1rem] sm:[--creator-canvas-padding:1.5rem] min-[1120px]:min-h-0 min-[1120px]:overflow-y-auto'
            : CANVAS_STAGE_CLASS,
          !flow && 'min-h-64'
        )}
      >
        {children}
      </div>
    </section>
  );
}

const CANVAS_STAGE_CLASS =
  'relative flex flex-1 items-center justify-center p-4 sm:p-6 [&_img]:max-h-[70svh] min-[1120px]:min-h-0 min-[1120px]:[container-type:size] min-[1120px]:[&_img]:max-h-full';

/**
 * In a `flow` canvas, the place a frame is fitted to, as the canvas's own body is in
 * the other: beside the column a size container that takes what the rest leaves it,
 * never less than 18rem; under the column the frame's width decides.
 */
export function CreatorCanvasStage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'relative flex min-h-64 flex-1 items-center justify-center [&_img]:max-h-[70svh] min-[1120px]:min-h-[18rem] min-[1120px]:[container-type:size] min-[1120px]:[&_img]:max-h-full',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * The run's line, as the canvas's chip says it: the run's model and settings, and what
 * it holds of the balance ("Seedance 2 Mini · 480P · 9:16 · 5s · 19 credits"). A run
 * that failed gave its credits back, so its line names none.
 */
export function creatorRunChip(label: string | null | undefined, cost: number | null | undefined): string | null {
  const credits = typeof cost === 'number' && cost > 0 ? creditsWords(cost) : null;
  return [label || null, credits].filter(Boolean).join(' · ') || null;
}

/**
 * The canvas's chip for where the run is (`creatorCanvasPhase`): the run's line while it works
 * and once it is done, without credits once it failed (they came back), and none before a run.
 */
export function creatorCanvasChip(phase: CreatorCanvasPhase, label: string | null | undefined, cost: number | null | undefined): string | null {
  if (phase === 'done' || phase === 'generating') return creatorRunChip(label, cost);
  return phase === 'failed' ? creatorRunChip(label, null) : null;
}

/**
 * Under a run at work (the artboard Generating): that the page can be left, where the
 * result will land and that an alert says when (the Alerts tab's row, `notifyGenerationStatus`,
 * and the toast on an open page), and what the run holds of the balance.
 */
export function CreatorRunWaitLines({ noun, heldCredits }: { noun: string; heldCredits: number | null }) {
  return (
    <div className="mx-auto max-w-md space-y-2 text-center text-sm leading-6 text-[var(--ui-text-muted)]">
      <p>You can leave this page: your {noun} keeps going, lands in your Studio, and you’ll get an alert when it’s ready.</p>
      {heldCredits !== null && heldCredits > 0 ? (
        <p className="flex items-start justify-center gap-2 text-[var(--ui-text-secondary)]">
          <Info aria-hidden className="mt-1 h-4 w-4 shrink-0" />
          <span>{creditsWords(heldCredits)} {heldCredits === 1 ? 'is' : 'are'} held for this run. If it fails, {heldCredits === 1 ? 'it comes' : 'they come'} back.</span>
        </p>
      ) : null}
    </div>
  );
}

/** What a run's failure says when the model's service gave no reason, or only a generic one. */
const GENERIC_RUN_FAILURES = new Set(['', 'unknown error', 'generation failed', 'video generation failed', 'image generation failed']);

/**
 * The cause a failed run's canvas names (the artboard Failed): the reason the server
 * recorded (`provider-failure-messages.ts` rewrites the ones it knows for creators),
 * or, where it gave none, that the model's service stopped first.
 */
export function describeRunFailure(message: string | null | undefined, noun: string): string {
  const reason = (message ?? '').trim();
  return GENERIC_RUN_FAILURES.has(reason.toLowerCase().replace(/[.!]+$/, ''))
    ? `The model’s service stopped before your ${noun} was done.`
    : reason;
}

/** "Your 19 credits are back.": a failed run's hold, always returned; the amount where it is known. */
function creditsBackSentence(returnedCredits: number | null): string {
  return returnedCredits !== null && returnedCredits > 0
    ? `Your ${creditsWords(returnedCredits)} ${returnedCredits === 1 ? 'is' : 'are'} back.`
    : 'Your credits are back.';
}

/**
 * A run that failed (the artboard Failed): its cause, that its credits are back, and the
 * same run again, priced, or the prompt to change it first. Where the same run cannot get
 * past the cause (`isRetryableProviderFailure`), another model stands in for Try again.
 */
export function CreatorRunFailed({ cause, returnedCredits, retryLabel, retryDisabled, onRetry, retryable = true, onPickModel, onChangePrompt }: {
  cause: string;
  /** What the run held, returned with its failure; null where it is not known. */
  returnedCredits: number | null;
  /** "Try again · 19 credits". */
  retryLabel: string;
  /** Where the bar offers something else than Generate (a top-up, the fitted remix), Try again waits too. */
  retryDisabled: boolean;
  onRetry: () => void;
  retryable?: boolean;
  /** Opens the model picker, in place of a retry that cannot succeed. */
  onPickModel?: () => void;
  onChangePrompt: () => void;
}) {
  return (
    <div className="w-full max-w-sm rounded-ui-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 text-center">
      <CircleAlert aria-hidden className="mx-auto h-6 w-6 text-amber-300" />
      <div role="alert" className="mt-3 space-y-2">
        <p className="text-base font-bold leading-6 text-[var(--ui-text-primary)] [overflow-wrap:anywhere]">{cause}</p>
        <p className="text-sm leading-6 text-[var(--ui-text-muted)]">{creditsBackSentence(returnedCredits)}</p>
      </div>
      <div className="mt-5 grid gap-2">
        {retryable || !onPickModel ? (
          <button type="button" onClick={onRetry} disabled={retryDisabled} className={CREATOR_BAR_PRIMARY_CLASS}>
            <span className="truncate">{retryLabel}</span>
          </button>
        ) : (
          <button type="button" onClick={onPickModel} className={CREATOR_BAR_PRIMARY_CLASS}>
            <span className="truncate">Pick another model</span>
          </button>
        )}
        <button type="button" onClick={onChangePrompt} className="ui-button ui-button-secondary ui-focus-ring min-h-12 w-full">
          Change the prompt
        </button>
      </div>
    </div>
  );
}

/**
 * The bar's word on a failed run under the column, where the canvas may be out of view (a
 * creator at the next prompt on a phone): that it failed, that its credits are back, and
 * the way to the canvas, which says why. Beside the column the canvas is in view: none.
 */
export function CreatorRunFailedLine({ returnedCredits, onSeeWhy }: { returnedCredits: number | null; onSeeWhy: () => void }) {
  return (
    <p className="text-amber-200">
      Your run didn’t finish. {creditsBackSentence(returnedCredits)}{' '}
      <button type="button" onClick={onSeeWhy} className={CREATOR_NOTE_LINK_CLASS}>See why</button>
    </p>
  );
}

/**
 * "16:9" → 16/9; "auto", anything unreadable and no ratio at all → null. A model
 * known only from the catalog's summary has no ratios until its details arrive.
 */
export function parseAspectRatio(aspectRatio: string | null | undefined): number | null {
  if (typeof aspectRatio !== 'string') return null;
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
  // Under the column the width decides, short of 70% of the window's smallest
  // height (svh: a phone's toolbar coming and going does not resize it); beside
  // it, the canvas's shorter side.
  'aspect-[var(--creator-frame-ratio)] w-[min(100%,calc(70svh*var(--creator-frame-ratio)))] min-[1120px]:w-[min(100cqw,calc(100cqh*var(--creator-frame-ratio)))]';

/**
 * A result beside or above the publish form: its column's width, short of 60% of a phone's
 * smallest height (a 9:16 clip about 285px wide at 390 × 844, so the form starts on the first
 * screen), and beside the column short of the pane's height less 26rem, so that stacked above the
 * form the form's head and its Publish still show under it (a 9:16 clip about 235px wide in a
 * 900px window; the mock-up's is 260).
 */
const DONE_FRAME_SIZE_CLASS =
  'aspect-[var(--creator-frame-ratio)] w-[min(100%,calc(60svh*var(--creator-frame-ratio)))] min-[1120px]:w-[min(100%,calc((100dvh-var(--app-shell-topbar-height)-26rem)*var(--creator-frame-ratio)))]';

function clampFrameRatio(ratio: number) {
  return Math.min(CANVAS_FRAME_RATIO_LIMITS.max, Math.max(CANVAS_FRAME_RATIO_LIMITS.min, ratio));
}

/**
 * A finished clip on black, beside or above the publish form (`CreatorDoneLayout`), where its
 * own column decides its width, short of what the window's height leaves for the form to start
 * in view: in the shape its frame had (square for "auto", as the frame is) until the clip's own
 * size is known, then in that. A motion run takes its shape from its reference, which the page
 * does not measure, and a model can answer "auto" with any shape. Give it the clip's address as
 * its `key`, so a new clip is measured afresh.
 */
export function CreatorCanvasMedia({ aspectRatio, children }: {
  aspectRatio?: string | null;
  children: ReactNode;
}) {
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

  const ratio = clampFrameRatio(clipRatio ?? parseAspectRatio(aspectRatio) ?? 1);
  return (
    <div
      ref={boxRef}
      data-testid="creator-canvas-media"
      style={{ '--creator-frame-ratio': ratio } as CSSProperties}
      className={clsx('relative overflow-hidden rounded-ui-xl bg-black', DONE_FRAME_SIZE_CLASS)}
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
  aspectRatio?: string | null;
  accent?: UiAccent;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="creator-canvas-frame"
      style={{ '--creator-frame-ratio': clampFrameRatio(parseAspectRatio(aspectRatio) ?? 1) } as CSSProperties}
      className={clsx(
        'relative flex items-center justify-center overflow-hidden rounded-ui-xl border',
        CANVAS_FRAME_SIZE_CLASS,
        busy ? 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]' : 'border-dashed border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)]'
      )}
    >
      {busy ? (
        <div aria-hidden className={clsx('absolute inset-0 animate-pulse bg-gradient-to-b motion-reduce:animate-none', getAccentClasses(accent).surface)} />
      ) : null}
      <div className="relative flex w-full min-w-0 max-w-xs flex-col items-center gap-3 px-6 text-center">{children}</div>
    </div>
  );
}
