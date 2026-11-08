'use client';

import Link from 'next/link';
import type { ComponentPropsWithoutRef, ComponentPropsWithRef, CSSProperties, DragEvent, FocusEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { Children, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, CircleAlert, Images, Info, LayoutTemplate, Loader2, Pencil, Play, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

import InlineMediaVideo from '@/components/InlineMediaVideo';
import {
  MEDIA_TOOL_IDS,
  StudioElementHandle,
  StudioUploadedMediaPreview,
  type StudioMediaPreviewType,
} from '@/components/CreatorStudio';
import { CreditTopUpHost } from '@/components/CreditTopUpSheet';
import { choiceKeyTarget, getAccentClasses, IconButton, type UiAccent } from '@/components/DesignSystem';
import type { CreatorCanvasPhase } from '@/lib/creator-canvas-phase';
import { openCreditTopUp, type CreditTopUpNeed } from '@/lib/credit-top-up';
import { getCreatorTool, type CreatorToolId } from '@/lib/creator-tools';
import { isValidElementHandle } from '@/lib/image-elements';
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
 * at most 680px wide, so a tablet keeps the app's proportions. Side by side, the
 * bar between them drags the column wider or narrower (`CreatorColumnResizer`).
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
  const gridRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const columnId = useId();
  const storedWidth = useStoredColumnWidth();
  return (
    // Its own stacking context: the model picker's layer 50 stays under the
    // shell's top bar (also 50) when the page scrolls.
    <div
      ref={gridRef}
      data-resized={storedWidth ? '' : undefined}
      style={storedWidth ? ({ '--creator-column-width': `${storedWidth}px` } as CSSProperties) : undefined}
      className={clsx(
        'relative z-10 mx-auto grid w-full max-w-[680px] grid-cols-1 gap-4 px-[clamp(1rem,1.9vw,2.25rem)] min-[1120px]:max-w-[1860px] min-[1120px]:grid-cols-[minmax(340px,400px)_minmax(0,1fr)] min-[1120px]:items-start min-[1120px]:gap-5 min-[1440px]:grid-cols-[minmax(380px,440px)_minmax(0,1fr)]',
        // A column dragged wider or narrower keeps that width, within the layout's floor and
        // what leaves the result its own floor (`COLUMN_RESULT_ROOM`, the result's 440px and the gap).
        'min-[1120px]:data-[resized]:grid-cols-[clamp(340px,var(--creator-column-width),calc(100%_-_460px))_minmax(0,1fr)]',
        resultFirst && 'max-[1120px]:[&>section]:order-first',
      )}
    >
      <h1 className="sr-only">{title}</h1>
      <div ref={columnRef} id={columnId} className="flex min-w-0 flex-col gap-3" onFocus={keepFocusClearOfBar}>{column}</div>
      {canvas}
      <CreatorColumnResizer gridRef={gridRef} columnRef={columnRef} columnId={columnId} />
      {/* Every Top up on the page sells credits here, without leaving what is set up. */}
      <CreditTopUpHost />
    </div>
  );
}

/** The column's width as the creator dragged it, kept in this browser: a viewer's own convenience. */
const COLUMN_WIDTH_STORAGE_KEY = 'creator-column-width';
/** The layout's own floor for the column, the width of the app's composer. */
const COLUMN_MIN_WIDTH = 340;
const COLUMN_MAX_WIDTH = 720;
/** What the column leaves beside it: the result's floor, 440px, and the 20px gap. */
const COLUMN_RESULT_ROOM = 460;
const COLUMN_KEY_STEP = 16;
const columnWidthListeners = new Set<() => void>();

function readStoredColumnWidth(): number | null {
  try {
    const width = Number(window.localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY));
    return Number.isFinite(width) && width >= COLUMN_MIN_WIDTH ? width : null;
  } catch {
    // Storage refused (a private window): the layout's own width.
    return null;
  }
}

function saveColumnWidth(width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(COLUMN_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Kept for this page only.
  }
  columnWidthListeners.forEach((listener) => listener());
}

function subscribeColumnWidth(listener: () => void) {
  columnWidthListeners.add(listener);
  // Another tab's drag reaches this one too.
  window.addEventListener('storage', listener);
  return () => {
    columnWidthListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** The kept width, read after hydration: the server draws the layout's own width. */
function useStoredColumnWidth(): number | null {
  return useSyncExternalStore(subscribeColumnWidth, readStoredColumnWidth, () => null);
}

/**
 * The widths a drag can reach in a grid this wide: from the layout's floor to the most that
 * leaves the result its own, and never past 720px.
 */
export function columnWidthBounds(gridContentWidth: number): { min: number; max: number } {
  return {
    min: COLUMN_MIN_WIDTH,
    max: Math.max(COLUMN_MIN_WIDTH, Math.min(COLUMN_MAX_WIDTH, gridContentWidth - COLUMN_RESULT_ROOM)),
  };
}

/** The same for the grid as drawn: its width inside its padding. */
function gridColumnBounds(grid: HTMLElement | null) {
  if (!grid) return columnWidthBounds(0);
  const style = getComputedStyle(grid);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return columnWidthBounds(grid.clientWidth - padding);
}

/**
 * The bar between the column and the result, which drags the column wider or narrower where
 * the two stand side by side (the owner's ask, 2026-11-02: "make this bar move sideways so we
 * can expand a little"). It is the window splitter of ARIA: a focusable separator that the
 * arrow keys move too (Shift for bigger steps, Home and End for the ends), and a double-click
 * or Enter gives the column back the layout's own width. A drag sets the grid's width variable straight
 * on the element, so the creator under it does not render again at every step; the width is
 * kept once the drag ends. It stands in the gap at the column's right edge, as tall as the row,
 * with its grip held in the middle of the window.
 */
function CreatorColumnResizer({ gridRef, columnRef, columnId }: {
  gridRef: RefObject<HTMLDivElement | null>;
  columnRef: RefObject<HTMLDivElement | null>;
  columnId: string;
}) {
  // What the separator says to a screen reader: the column's width and the most it can take.
  const [measure, setMeasure] = useState<{ width: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; moved: boolean } | null>(null);

  useEffect(() => {
    const column = columnRef.current;
    const grid = gridRef.current;
    if (!column || !grid || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setMeasure({
      width: Math.round(column.getBoundingClientRect().width),
      max: gridColumnBounds(grid).max,
    }));
    observer.observe(column);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [columnRef, gridRef]);

  const columnWidth = () => columnRef.current?.getBoundingClientRect().width || measure?.width || COLUMN_MIN_WIDTH;
  const apply = (next: number) => {
    const grid = gridRef.current;
    if (!grid) return next;
    const { min, max } = gridColumnBounds(grid);
    const clamped = Math.round(Math.min(max, Math.max(min, next)));
    grid.dataset.resized = '';
    grid.style.setProperty('--creator-column-width', `${clamped}px`);
    return clamped;
  };
  const endDrag = () => {
    if (!drag.current) return;
    const { moved } = drag.current;
    drag.current = null;
    setDragging(false);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
    // A press that never moved (the first half of a double-click) keeps the layout's own width.
    if (moved) saveColumnWidth(columnWidth());
  };
  const reset = () => {
    const grid = gridRef.current;
    if (grid) {
      delete grid.dataset.resized;
      grid.style.removeProperty('--creator-column-width');
    }
    saveColumnWidth(null);
  };
  return (
    // The whole gap is the drag's reach. In it, at the column's right edge, as tall as the row; only
    // where the two panes stand side by side. Absolute, so it takes no cell of its own (as a grid item
    // it pushed the column into the second track); both lines are named, since an absolute item's
    // auto end line is the grid's edge.
    <div
      title="Drag to resize. Double-click, or Enter on the grip, to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width: columnWidth(), moved: false };
        setDragging(true);
        document.body.style.setProperty('cursor', 'col-resize');
        document.body.style.setProperty('user-select', 'none');
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const moved = event.clientX - drag.current.x;
        if (!drag.current.moved && Math.abs(moved) < 2) return;
        drag.current.moved = true;
        apply(drag.current.width + moved);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={reset}
      className="group/resizer absolute inset-y-0 right-0 hidden w-5 translate-x-full cursor-col-resize touch-none min-[1120px]:col-[1/2] min-[1120px]:row-[1/2] min-[1120px]:block"
    >
      <span
        aria-hidden
        className={clsx(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150',
          dragging ? 'bg-[var(--ui-border-strong)]' : 'bg-transparent group-hover/resizer:bg-[var(--ui-border-default)]'
        )}
      />
      {/* The grip, held in the middle of the window however long the column is, is what the keyboard
          focuses: focusing the whole row's height scrolled the page to its top. */}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label="Column width"
        aria-controls={columnId}
        aria-valuenow={measure?.width}
        aria-valuemin={COLUMN_MIN_WIDTH}
        aria-valuemax={measure?.max ?? COLUMN_MAX_WIDTH}
        tabIndex={0}
        onKeyDown={(event) => {
          // The keyboard's way to the layout's own width, which a double-click gives a mouse.
          if (event.key === 'Enter') {
            event.preventDefault();
            reset();
            return;
          }
          const step = event.shiftKey ? COLUMN_KEY_STEP * 4 : COLUMN_KEY_STEP;
          const target = event.key === 'ArrowLeft' ? columnWidth() - step
            : event.key === 'ArrowRight' ? columnWidth() + step
              : event.key === 'Home' ? -Infinity
                : event.key === 'End' ? Infinity
                  : null;
          if (target === null) return;
          event.preventDefault();
          saveColumnWidth(apply(target));
        }}
        className={clsx(
          'ui-focus-ring sticky top-[calc(50vh-1.25rem)] mx-auto block h-10 w-1.5 rounded-full outline-none transition-colors duration-150',
          dragging ? 'bg-[var(--ui-text-secondary)]' : 'bg-[var(--ui-border-strong)] group-hover/resizer:bg-[var(--ui-text-muted)]'
        )}
      />
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
const FLOATING_SURFACE_FILL = 'border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] shadow-ui-panel';
const FLOATING_SURFACE_CLASS = `rounded-ui-2xl ${FLOATING_SURFACE_FILL}`;
/** The bar holds its capsules 8px in, so its corners are concentric with theirs: 24 + 8. */
const FLOATING_BAR_CLASS = `rounded-4xl ${FLOATING_SURFACE_FILL}`;

/**
 * The box an aspect-ratio option draws beside its words, as the app's parameter
 * sheet does: the long side 14px and the short side to scale, never under 3px, so
 * 1:8 still shows as a bar. Nothing for "auto". The creators hand it to their
 * ratio choices as `optionMark`, as the app picks its ratio control by its key.
 */
export function aspectRatioMark(option: string): ReactNode {
  const ratio = parseAspectRatio(option);
  if (ratio === null) return null;
  const toScale = (share: number) => Math.max(3, Math.round(14 * share));
  return (
    <span
      aria-hidden
      data-testid="creator-option-ratio-box"
      className="shrink-0 rounded-xs border-[1.5px] border-current"
      style={ratio >= 1 ? { width: 14, height: toScale(1 / ratio) } : { width: toScale(ratio), height: 14 }}
    />
  );
}

/**
 * One setting with a single value (aspect ratio, resolution, quality): a radio
 * group of equal cells, so a screen reader hears which one is chosen, and the
 * arrow keys move the choice as they do in any radio group. The parent decides
 * whether a pick takes effect: one that asks first leaves `value` where it was
 * until it is answered. A choice of a few words with no price, a mode such as
 * the video creator's shot mode, is the shared `SegmentedControl` instead.
 */
export function CreatorSettingChoices<T extends string>({
  label,
  hint,
  options,
  optionLabel,
  value,
  onChange,
  columns,
  accent = 'image',
  capitalize = false,
  optionPrice,
  optionMark,
}: {
  label: string;
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
   * What the run costs with each option, under it: the total, "23", in amber past the
   * balance, with the words a screen reader says ("23 credits, 1 more than your balance";
   * `optionPricesOf`); null where it is not known yet. An option past the balance stays
   * selectable: the bar offers a top-up in Generate's place.
   */
  optionPrice?: (option: T) => OptionPrice | null;
  /** A small picture before an option's words (the ratios' boxes: `aspectRatioMark`), in the accent once chosen. */
  optionMark?: (option: T) => ReactNode;
}) {
  const labelId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.indexOf(value);
  const { selected: selectedClasses, mark: selectedMarkClass } = getAccentClasses(accent);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = choiceKeyTarget(event, index, options.length);
    if (next === null) return;
    event.preventDefault();
    onChange(options[next]);
    optionRefs.current[next]?.focus();
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p id={labelId} className="text-xs font-bold text-[var(--ui-text-muted)]">{label}</p>
        {hint ? <p className="text-xs text-[var(--ui-text-faint)]">{hint}</p> : null}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={clsx('grid gap-1.5', CHOICE_COLUMNS[columns])}
      >
        {options.map((option, index) => {
          const checked = index === selectedIndex;
          const price = optionPrice?.(option) ?? null;
          const text = optionLabel ? optionLabel(option) : option;
          const mark = optionMark?.(option) ?? null;
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
                // The room a mark has is measured on the option itself, and its line is
                // centred, so a long one shares the padding on both sides.
                mark && '@container flex items-center justify-center',
                capitalize && 'capitalize',
                checked
                  ? selectedClasses
                  : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-secondary)]'
              )}
            >
              {mark ? (
                // Side by side, as in the app, at every width a creator's column has (options from
                // about 54px); stacked only narrower (five to a row on a 320px phone), where a long
                // ratio such as 27:16 would run past the option's border.
                <span className="inline-flex items-center gap-1 @max-[2.25rem]:flex-col @max-[2.25rem]:gap-0.5">
                  {/* The mark takes the option's colour, and the accent once chosen, as in the app. */}
                  <span className={clsx('inline-flex shrink-0', checked && selectedMarkClass)}>{mark}</span>
                  {text}
                </span>
              ) : (
                <span>{text}</span>
              )}
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
 * The foot of the column, kept in reach while the column scrolls: on a phone
 * on the window's bottom edge (the creators hide the shell's bottom navigation
 * there), just above it from 768px. As in the
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
    // Below 768px (in px, as the shell's own breakpoint) the creators hide the shell's bottom
    // navigation (`hidesBottomNav`), so the bar holds the window's bottom edge in its place, the
    // safe area inside it; wider, it floats just above the edge. Under the column's width it waits
    // at the column's end while a done run's Publish bar holds the foot.
    <div
      ref={barRef}
      data-creator-bar
      className={clsx(
        'sticky bottom-3 z-30 mt-1 max-[768px]:bottom-0',
        !holdsFootUnderColumn && 'max-[1120px]:static',
      )}
    >
      {/* One surface for the line and the bar, so nothing scrolling under the
          bar shows between them, and opaque, so nothing needs blurring behind it. */}
      <div className={clsx(FLOATING_BAR_CLASS, 'overflow-hidden', holdsFootUnderColumn && 'max-[768px]:pb-[env(safe-area-inset-bottom)]')}>
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
        <div className={'flex items-stretch gap-2 p-2 min-[1120px]:flex-col'}>
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
                'min-[1120px]:flex-none',
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
          <div className={'flex min-w-0 flex-[1.2] min-[1120px]:flex-none'}>{action}</div>
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
  topUpNeed = null,
  topUpHref = '/pricing',
}: {
  awaitingCheck: boolean;
  onCheckAgain: () => void;
  showTopUp: boolean;
  /** The run the top-up is for, which the sheet weighs its packs against. */
  topUpNeed?: CreditTopUpNeed;
  /**
   * Where the sheet's way to the pricing page leads, and where a page with no sheet goes: Pricing,
   * told on a remix to bring the creator back to it (`buildRemixTopUpHref`).
   */
  topUpHref?: string;
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
    // The packs on the page (`CreditTopUpSheet`), not the pricing page: the run stays set up (owner, 2026-11-02).
    return (
      <button type="button" onClick={() => openCreditTopUp(topUpNeed, topUpHref)} className={CREATOR_BAR_PRIMARY_CLASS}>
        <Sparkles aria-hidden className="h-4 w-4" />
        Top Up Credits
      </button>
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
          : 'Sign in with Google or Apple to generate'}
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

const NOTE_STRONG_CLASS = 'font-bold text-[var(--ui-text-secondary)]';

/** A link in the line under the bar: the words' size, its press area the 44px of a control. */
export const CREATOR_NOTE_LINK_CLASS =
  "ui-focus-ring relative rounded-lg font-semibold text-[var(--ui-text-secondary)] underline underline-offset-4 after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] hover:text-[var(--ui-text-primary)]";

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

/** A small pill action on a reference: Insert, Copy, Add video. */
export const CREATOR_REFERENCE_CHIP_CLASS =
  'ui-focus-ring inline-flex min-h-9 shrink-0 items-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 text-xs font-semibold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-surface-3)] disabled:cursor-not-allowed disabled:opacity-50';

/** The @handle as the button that inserts it: each reference tile's, as the creators' hints say ("tap a handle"). */
const CREATOR_HANDLE_INSERT_CLASS =
  'ui-focus-ring inline-flex min-h-9 min-w-0 max-w-full items-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 py-1 text-left transition-colors hover:bg-[var(--ui-surface-3)]';

/**
 * Replace on a reference a remix brought back (the artboard Remix): a file of the creator's
 * own takes its place, and keeps its name and @handle, so the prompt still reads.
 */
function CreatorReplaceButton({ label, accept, onFile }: {
  /** Named for what it replaces: "Replace @reference_1 with your own photo". */
  label: string;
  accept: string;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => inputRef.current?.click()} aria-label={label} className={CREATOR_REFERENCE_CHIP_CLASS}>
        Replace
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

/**
 * A row of cards that scrolls sideways, snapping to each: the start posts' strip
 * (`CreatorStartPosts`) and the references'. Each sets its own cell width and gap,
 * which a second `auto-cols-*` in a `className` could not override.
 */
export const SIDEWAYS_TRACK_CLASS = 'app-scrollbar -mx-1 grid snap-x grid-flow-col overflow-x-auto px-1 pb-2';

/** How far a mouse moves on a strip before its press becomes a drag that scrolls the strip. */
const STRIP_DRAG_THRESHOLD = 6;

/**
 * A creator's references side by side in one row that scrolls sideways, as the
 * app lists them, so ten references take one row of the column rather than ten.
 * One added to a strip that already had some comes into view, as a row added
 * under the list did; the first ones, or a remix's restored set, start at the left.
 *
 * A mouse drags the row sideways, as a finger swipes it (the owner's ask, 2026-11-02):
 * a press that moves 6px becomes a drag, the click that ends it presses nothing, and a
 * press in a field (a name) stays the field's, to type and select in.
 */
export function CreatorReferenceStrip({ className, children, wide = false, ...props }: ComponentPropsWithoutRef<'ul'> & {
  /** Wider cells, for tiles that hold a player (a track's). */
  wide?: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const count = Children.count(children);
  const shownCount = useRef(count);
  const reduceMotion = useReducedMotion();
  const pan = useRef<{ pointerId: number; x: number; scrollLeft: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  const endPan = () => {
    const current = pan.current;
    const list = listRef.current;
    pan.current = null;
    if (!current?.moved || !list) return;
    for (const property of ['cursor', 'user-select', 'scroll-snap-type']) list.style.removeProperty(property);
    // The click that ends a drag is no press on what the pointer stopped over (a Remove, a preview).
    swallowClick.current = true;
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
  };

  useEffect(() => {
    const list = listRef.current;
    if (list && shownCount.current > 0 && count > shownCount.current) {
      if (typeof list.scrollTo === 'function') {
        list.scrollTo({ left: list.scrollWidth, behavior: reduceMotion ? 'auto' : 'smooth' });
      } else {
        list.scrollLeft = list.scrollWidth;
      }
    }
    shownCount.current = count;
  }, [count, reduceMotion]);

  return (
    <ul
      {...props}
      ref={listRef}
      onPointerDown={(event) => {
        const list = listRef.current;
        // A finger or a pen scrolls the row itself; a row that fits has nowhere to go.
        if (event.pointerType !== 'mouse' || event.button !== 0 || !list || list.scrollWidth <= list.clientWidth) return;
        // A press in a field, or on a player's own controls (a track's seek bar), is that control's.
        if (event.target instanceof Element && event.target.closest('input, textarea, select, audio, video, [contenteditable="true"]')) return;
        pan.current = { pointerId: event.pointerId, x: event.clientX, scrollLeft: list.scrollLeft, moved: false };
      }}
      onPointerMove={(event) => {
        const current = pan.current;
        const list = listRef.current;
        if (!current || !list || event.pointerId !== current.pointerId) return;
        // A press let go outside the row before it moved has ended: the row heard no release.
        if ((event.buttons & 1) === 0) {
          endPan();
          return;
        }
        const dx = event.clientX - current.x;
        if (!current.moved) {
          if (Math.abs(dx) < STRIP_DRAG_THRESHOLD) return;
          current.moved = true;
          list.setPointerCapture?.(event.pointerId);
          window.getSelection()?.removeAllRanges();
          // Snapping would pull the row back at every step; it settles on a card once the drag ends.
          list.style.setProperty('scroll-snap-type', 'none');
          list.style.setProperty('cursor', 'grabbing');
          list.style.setProperty('user-select', 'none');
        }
        list.scrollLeft = current.scrollLeft - dx;
      }}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onLostPointerCapture={endPan}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      // A picture dragged as a file would take the pointer from the row.
      onDragStart={(event) => event.preventDefault()}
      className={clsx(SIDEWAYS_TRACK_CLASS, wide ? 'auto-cols-[13rem]' : 'auto-cols-[8rem]', 'gap-2', className)}
    >
      {children}
    </ul>
  );
}

/** What a reference tile's preview opens: its file, by kind, under the reference's name. */
export interface CreatorReferencePreviewTarget {
  kind: 'image' | 'video';
  src: string;
  name: string;
}

/**
 * A reference tile's picture (`CreatorReferenceTile`'s `preview`), which opens the file in the
 * creator's preview: the picture itself, or a clip's first frame under a play mark, square or
 * wide (a Kling video element). A clip with no link yet draws the frame empty and opens nothing.
 */
export function CreatorReferencePreview({ kind, src, name, wide = false, onPreview }: {
  kind: 'image' | 'video';
  src: string | null;
  name: string;
  wide?: boolean;
  onPreview: (target: CreatorReferencePreviewTarget) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (src) onPreview({ kind, src, name });
      }}
      aria-label={`Preview ${name}`}
      className={clsx(
        'ui-focus-ring relative block w-full overflow-hidden rounded-ui-md border border-[var(--ui-border-default)]',
        wide ? 'aspect-video' : 'aspect-square',
        kind === 'image' ? 'group bg-[var(--ui-surface-inset)]' : 'bg-black',
      )}
    >
      {kind === 'image' ? (
        src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={name}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
          />
        ) : null
      ) : (
        <>
          {src ? (
            <InlineMediaVideo src={src} className="pointer-events-none h-full w-full object-cover" muted playsInline preload="metadata" />
          ) : null}
          <Play aria-hidden className="absolute bottom-1 right-1 h-3.5 w-3.5 text-white/90" />
        </>
      )}
    </button>
  );
}

/**
 * A reference in a creator's column, as a tile in its strip: its picture or
 * clip (which opens a preview) with Remove on it, its name to rename it by, and
 * its @handle, which is the button that inserts it, each named for what it acts
 * on. Copy (a Kling clip), Replace (a remix's reference) and a note sit under
 * the handle. The handle has the tile's width to itself and breaks after an
 * underscore, so it always shows whole (`reference-card-handles.spec.ts`).
 */
export function CreatorReferenceTile({
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
  replace,
}: {
  accent: UiAccent;
  /** The picture or clip at the tile's top, as wide as the tile. */
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
  /** A remix's reference: a file of the creator's own takes its place. */
  replace?: { label: string; accept: string; onFile: (file: File) => void };
}) {
  return (
    <li className="flex min-w-0 snap-start flex-col gap-1.5 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-1.5">
      <div className="relative">
        {preview}
        <TileRemoveButton label={`Remove ${displayName}`} onRemove={onRemove} />
      </div>
      {/* The name is a field, and a pencil says so while it is not being typed in: as plain
          words it read as a label, and its hover border never shows on a touch screen. The
          pencil lets a press through to the field under it. */}
      <div className="relative">
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
          // A tile shows about a dozen characters of a long name; the rest on hover.
          title={nameDraft ?? displayName}
          placeholder={placeholder}
          className={clsx(
            'peer w-full min-w-0 rounded-ui-sm border border-transparent bg-transparent py-1 pl-1.5 pr-6 text-sm font-semibold text-[var(--ui-text-primary)] outline-none transition-colors hover:border-[var(--ui-border-default)] focus:bg-[var(--ui-surface-2)] focus:pr-1.5',
            getAccentClasses(accent).fieldFocus
          )}
        />
        <Pencil
          aria-hidden
          data-name-edit-mark
          className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ui-text-faint)] transition-colors peer-hover:text-[var(--ui-text-secondary)] peer-focus:hidden"
        />
      </div>
      <button type="button" onClick={onInsert} aria-label={`Insert ${handle}`} title={`Insert ${handle}`} className={CREATOR_HANDLE_INSERT_CLASS}>
        <StudioElementHandle handle={handle} className={clsx('text-xs font-semibold', handleClassName)} />
      </button>
      {replace || onCopy ? (
        <div className="flex flex-wrap gap-1.5">
          {replace ? <CreatorReplaceButton {...replace} /> : null}
          {onCopy ? (
            <button type="button" onClick={onCopy} aria-label={`Copy ${handle}`} className={CREATOR_REFERENCE_CHIP_CLASS}>
              Copy
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="px-1.5 text-xs text-[var(--ui-text-faint)]">{note}</p> : null}
    </li>
  );
}

/** Remove on a tile's picture or clip: 48px to press, as every icon button is, and a 32px circle to see, so the picture stays visible. */
function TileRemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={label}
      title={label}
      className="ui-focus-ring group/remove absolute right-0 top-0 inline-flex h-12 w-12 items-start justify-end rounded-full p-1"
    >
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white transition group-hover/remove:bg-rose-500/90">
        <X className="h-4 w-4" aria-hidden />
      </span>
    </button>
  );
}

/**
 * Under a reference opened at full size, what the app's Reference details sheet holds: its
 * name, Insert its @handle, Replace its file (a reference with a handle keeps it, so the
 * prompt that mentions it stays right) and Remove. A clip or a track has no handle, so it has
 * no name field or Insert. The name is the tile's field: what is typed is kept on Enter or on
 * leaving it, and Escape takes it back (and only that, while there is something to take back:
 * a second Escape closes the preview).
 */
export function CreatorReferenceDetails({
  accent,
  name,
  insert,
  replace,
  onRemove,
  note,
}: {
  accent: UiAccent;
  name?: {
    displayName: string;
    draft: string | undefined;
    placeholder: string;
    onChange: (value: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  };
  insert?: { handle: string; handleClassName: string; onInsert: () => void };
  /** `keeps`: the handle the new file keeps, said on the button. */
  replace?: { accept: string; keeps?: string; onFile: (file: File) => void };
  onRemove: () => void;
  /** A line under the actions: why the run holds this reference back, where it does. */
  note?: ReactNode;
}) {
  const nameId = useId();
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-4">
      {name ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={nameId} className={CREATOR_REFERENCE_DETAILS_LABEL_CLASS}>Reference name</label>
          <input
            id={nameId}
            type="text"
            value={name.draft ?? name.displayName}
            onChange={(event) => name.onChange(event.target.value)}
            onBlur={name.onCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                name.onCommit();
              }
              if (event.key === 'Escape' && name.draft !== undefined) {
                // The preview closes on Escape; while a name is being typed, this one only takes it back.
                event.preventDefault();
                name.onCancel();
              }
            }}
            placeholder={name.placeholder}
            className={clsx(
              'min-h-12 w-full rounded-ui-lg border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 text-sm font-semibold text-[var(--ui-text-primary)] outline-none transition-colors',
              getAccentClasses(accent).fieldFocus
            )}
          />
        </div>
      ) : null}
      {/* Each as wide as its words, sharing the row; where they do not fit, they wrap. */}
      <div className="flex flex-wrap gap-2">
        {insert ? (
          <button type="button" onClick={insert.onInsert} className="ui-button ui-button-secondary ui-focus-ring min-w-0 grow basis-auto">
            <span className={CREATOR_REFERENCE_DETAILS_WORDS_CLASS}>Insert <span className={insert.handleClassName}>{insert.handle}</span></span>
          </button>
        ) : null}
        {replace ? (
          <>
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              aria-label={replace.keeps ? `Replace media, keeps ${replace.keeps}` : 'Replace media'}
              className="ui-button ui-button-secondary ui-focus-ring min-w-0 grow basis-auto"
            >
              <RefreshCw aria-hidden className="h-4 w-4 shrink-0" />
              {/* Inside a phone's preview the row is narrower than the app's sheet: "media" goes first. */}
              <span className={CREATOR_REFERENCE_DETAILS_WORDS_CLASS}>
                Replace{replace.keeps ? <><span className="max-sm:hidden"> media</span> · keeps {replace.keeps}</> : ' media'}
              </span>
            </button>
            <input
              ref={pickerRef}
              type="file"
              accept={replace.accept}
              tabIndex={-1}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) replace.onFile(file);
              }}
            />
          </>
        ) : null}
        <button
          type="button"
          onClick={onRemove}
          className="ui-button ui-focus-ring min-w-0 grow basis-auto border border-[color-mix(in_srgb,var(--ui-accent-danger)_40%,transparent)] bg-transparent text-[var(--ui-accent-danger)] hover:bg-[color-mix(in_srgb,var(--ui-accent-danger)_10%,transparent)]"
        >
          <Trash2 aria-hidden className="h-4 w-4 shrink-0" />
          Remove reference
        </button>
      </div>
      {note ? <p className="text-xs text-[var(--ui-text-faint)]">{note}</p> : null}
    </div>
  );
}

/** A button's words wrap rather than cut off a long handle: the button grows a line taller. */
const CREATOR_REFERENCE_DETAILS_WORDS_CLASS = 'min-w-0 text-balance text-center [overflow-wrap:anywhere]';
const CREATOR_REFERENCE_DETAILS_LABEL_CLASS = 'text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--ui-text-muted)]';

/**
 * A clip or a track as a tile in its row, as the app's rail draws them: a clip's frame on top
 * (which opens it) with Remove on it, or for a track its name with Remove beside it and its
 * player under; its name, the line under it (its length, red where the run holds it back, or
 * what the run makes of it), and Replace on one a remix brought back. A clip or a track has no
 * @handle, so the tile has no name field and no Insert.
 */
export function CreatorMediaReferenceTile({
  preview,
  player,
  displayName,
  line,
  lineHeld = false,
  onRemove,
  replace,
}: {
  /** A clip's frame, as wide as the tile. */
  preview?: ReactNode;
  /** A track's player, under its name. */
  player?: ReactNode;
  displayName: string;
  line?: ReactNode;
  /** The line says why the run holds the reference back. */
  lineHeld?: boolean;
  onRemove: () => void;
  replace?: { label: string; accept: string; onFile: (file: File) => void };
}) {
  return (
    <li className="flex min-w-0 snap-start flex-col gap-1.5 rounded-ui-lg border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-1.5">
      {preview ? (
        <div className="relative">
          {preview}
          <TileRemoveButton label={`Remove ${displayName}`} onRemove={onRemove} />
        </div>
      ) : null}
      <div className="flex min-w-0 items-start justify-between gap-1">
        <div className="min-w-0 px-1.5 py-1">
          {/* A tile shows about a dozen characters of a long name; the rest on hover. */}
          <p className="truncate text-sm font-semibold text-[var(--ui-text-primary)]" title={displayName}>{displayName}</p>
          {line ? <p className={clsx('mt-0.5 text-xs', lineHeld ? 'text-red-400' : 'text-[var(--ui-text-faint)]')}>{line}</p> : null}
        </div>
        {preview ? null : <IconButton label={`Remove ${displayName}`} icon={X} onClick={onRemove} className="shrink-0" />}
      </div>
      {player}
      {replace ? (
        <div className="flex flex-wrap gap-1.5">
          <CreatorReplaceButton {...replace} />
        </div>
      ) : null}
    </li>
  );
}

/** How a remix's empty slot is drawn: a tile with a picture's frame, a clip's wide one, or a row. */
export type CreatorRemixSlotFrame = 'square' | 'wide' | 'none';

/**
 * An input a remix was not given, as an empty, dashed box in its place (owner, 2026-11-03): the
 * @handle the prompt knows it by, else its name (`remixInputSlotTitle`), and what to add
 * (`remixInputSlotAction`). A press opens the picker of its kind and a drop hands it files; the
 * page puts the remixer's file in its place, under its handle, and the box goes. A tile in a
 * reference strip (`as="li"`, the size of the tiles beside it) or a row of its own (`frame="none"`,
 * a named subject's).
 */
export function CreatorRemixSlotTile({
  accent,
  slotId,
  title,
  action,
  accept,
  multiple = false,
  frame = 'square',
  as: Wrapper = 'li',
  handleClassName,
  disabled = false,
  onFiles,
}: {
  accent: UiAccent;
  /** The slot's id, on its file field. */
  slotId: string;
  title: string;
  action: string;
  /** The file field's types. */
  accept: string;
  multiple?: boolean;
  frame?: CreatorRemixSlotFrame;
  as?: 'li' | 'div';
  /** A handle's colour, as the tiles beside it draw theirs. */
  handleClassName?: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const classes = getAccentClasses(accent);
  const label = dragging ? 'Drop here' : action;

  return (
    <Wrapper className={clsx('flex min-w-0', Wrapper === 'li' && 'snap-start')}>
      <button
        type="button"
        aria-label={`${action} for ${title}`}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        // A drop on the box is the box's alone: the creator's own drop target around a strip (the
        // image creator's references) would add the file a second time.
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files ?? []);
          if (files.length > 0 && !disabled) onFiles(files);
        }}
        className={clsx(
          'ui-focus-ring flex w-full min-w-0 rounded-ui-lg border border-dashed p-1.5 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
          frame === 'none' ? 'min-h-12 items-center gap-2 px-3' : 'flex-col gap-1.5',
          dragging
            ? clsx(classes.tileActive, 'text-[var(--ui-text-primary)]')
            : clsx(classes.tile, 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]')
        )}
      >
        {/* Nothing inside takes the pointer, so a drag over the words is no leave. */}
        {frame === 'none' ? (
          <Plus aria-hidden className={clsx('pointer-events-none h-4 w-4 shrink-0', classes.mark)} />
        ) : (
          <span
            className={clsx(
              'pointer-events-none flex w-full items-center justify-center rounded-ui-md bg-[var(--ui-surface-inset)]',
              frame === 'wide' ? 'aspect-video' : 'aspect-square'
            )}
          >
            <Plus aria-hidden className={clsx('h-5 w-5', classes.mark)} />
          </span>
        )}
        <span className={clsx('pointer-events-none flex min-w-0 flex-col gap-0.5', frame !== 'none' && 'px-1.5 pb-1')}>
          {/* A title that is a handle, by the server's own rule, which the mention grammar's parity test holds. */}
          {isValidElementHandle(title) ? (
            <StudioElementHandle handle={title} className={clsx('text-xs font-semibold', handleClassName ?? classes.accentText)} />
          ) : (
            // The box's title, so two lines of it rather than a cut ("Reference im…").
            <span className="line-clamp-2 text-sm font-semibold text-[var(--ui-text-primary)] [overflow-wrap:anywhere]" title={title}>{title}</span>
          )}
          <span className="text-xs text-[var(--ui-text-muted)]">{label}</span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        data-remix-slot={slotId}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </Wrapper>
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
 * A kind of reference an add box adds (a picture, a clip, a track): its words, its file field,
 * and how many the run holds of it and takes.
 */
export interface CreatorReferenceKind {
  /** Its word on its box: "Images". */
  railLabel: string;
  /** What it is for, the box's tooltip and description. */
  hint: string;
  /** The file field's types. */
  accept: string;
  count: number;
  limit: number;
  /** Takes the files picked or dropped for this kind. */
  onFiles: (files: File[]) => void;
}

/**
 * A kind of reference's row, as the app's rail is: the kind's dashed add box at the start,
 * outside the references' scroller so it is always in view, then the kind's references, or
 * while it has none, what the kind is for (the owner's ask, 2026-11-01: a box for each kind,
 * and each kind in a row of its own). The app keeps one rail with one box that asks which
 * kind, since three boxes ahead of the pictures left half the first one off a phone; a row for
 * each kind keeps every kind one press away and its references beside its box.
 */
export function CreatorReferenceRow({ accent, kind, stripLabel, wide, children }: {
  accent: UiAccent;
  kind: CreatorReferenceKind;
  /** The strip's name for a reader: "Reference videos". */
  stripLabel: string;
  /** Wider cells, for tiles that hold a player (CreatorReferenceStrip's). */
  wide?: boolean;
  /** The kind's tiles, drawn in a strip; none while it has none. */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <CreatorReferenceAddBox accent={accent} kind={kind} />
      {/* Counted as drawn: `Children.count` counts a `false` or `null` child as one. */}
      {Children.toArray(children).length > 0 ? (
        <CreatorReferenceStrip aria-label={stripLabel} wide={wide} className="min-w-0 flex-1">
          {children}
        </CreatorReferenceStrip>
      ) : (
        <p className="min-w-0 flex-1 self-center px-1 text-sm leading-6 text-[var(--ui-text-muted)]">{kind.hint}</p>
      )}
    </div>
  );
}

/**
 * A kind's dashed add box: "+", its word and how many of it the run holds, dimmed once full.
 * A press opens the kind's picker, and a drop hands the kind its files, whose check refuses one
 * of another kind as it refuses a pick.
 */
function CreatorReferenceAddBox({ accent, kind }: { accent: UiAccent; kind: CreatorReferenceKind }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const classes = getAccentClasses(accent);
  const word = kind.railLabel.toLowerCase();

  return (
    <div className="shrink-0">
      <button
        type="button"
        aria-label={`Add ${word}, ${kind.count} of ${kind.limit}`}
        aria-describedby={hintId}
        title={kind.hint}
        disabled={kind.count >= kind.limit}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files ?? []);
          if (files.length > 0) kind.onFiles(files);
        }}
        className={clsx(
          'ui-focus-ring flex h-20 w-20 flex-col items-center justify-center gap-0.5 rounded-ui-lg border border-dashed px-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
          // Quiet at rest, as the frame slots on the other side of the switch are; the accent
          // comes in on hover and while a file is over it, and the plus keeps it throughout.
          dragging
            ? clsx(classes.tileActive, 'text-[var(--ui-text-primary)]')
            : clsx('border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]', classes.tileHover)
        )}
      >
        {/* Nothing inside takes the pointer, so a drag over the icon is no leave. */}
        <Plus aria-hidden className={clsx('pointer-events-none mb-0.5 h-4 w-4', classes.mark)} />
        {/* The design guide's label (13px bold) and caption (12px, faint) roles. */}
        <span className="pointer-events-none text-[13px] font-bold leading-[18px]">{dragging ? 'Drop here' : kind.railLabel}</span>
        <span className="pointer-events-none text-xs font-semibold leading-[17px] tabular-nums text-[var(--ui-text-faint)]">{kind.count}/{kind.limit}</span>
        <span id={hintId} className="sr-only">{kind.hint}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={kind.accept}
        multiple
        tabIndex={-1}
        aria-label={`Add ${word}`}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) kind.onFiles(files);
        }}
      />
    </div>
  );
}

/**
 * The column's inputs as one card (the artboard Inputs, PR 4 of the creator redesign): its
 * kicker, the switch between its sides where the model takes both, the line that says what the
 * side shown does, a notice of what the run leaves out, and that side's slots.
 */
export function CreatorInputsCard({
  switcher,
  hint,
  notice,
  children,
}: {
  /** The switch, where the model takes both sides. */
  switcher?: ReactNode;
  hint?: string | null;
  /** What the run leaves out, above the slots. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className="ui-card p-4">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={titleId} className="ui-kicker">Inputs</h2>
        {switcher}
      </div>
      {hint ? <p className="mt-2 text-xs leading-5 text-[var(--ui-text-muted)]">{hint}</p> : null}
      {notice}
      <div className="mt-3 space-y-4">{children}</div>
    </div>
  );
}

/**
 * One input of fixed role (a start frame, the character image, the reference
 * video): empty, a dashed tile to add it; filled, its preview with Replace and
 * Remove. One file field serves both: the tile's label is for it, and Replace
 * clicks it. A remix not given the input names it on the empty tile instead
 * (`remixSlot`), in the accent, and the file the remixer adds fills it.
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
  remixSlot = null,
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
  /**
   * The input a remix was not given (owner, 2026-11-03): the empty tile says what it was
   * (`remixInputSlotTitle`) and asks for the remixer's own (`remixInputSlotAction`).
   */
  remixSlot?: { title: string; action: string } | null;
  /** The file field; give it an `id`, which the tile's label points at. Replace clicks it. */
  input: Omit<FileInputProps, 'ref'> & { id: string };
  onPreview: () => void;
  onRemove: () => void;
} & FileDropProps) {
  const classes = getAccentClasses(accent);
  const inputRef = useRef<HTMLInputElement>(null);
  const namesSlot = Boolean(remixSlot) && !dragging;
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
                : remixSlot
                  ? clsx(classes.tile, 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]')
                  : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-secondary)]'
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <Icon aria-hidden className={clsx('h-5 w-5', (dragging || remixSlot) && classes.mark)} />
            {namesSlot && remixSlot ? (
              <>
                <span className="text-xs font-semibold text-[var(--ui-text-primary)]">{remixSlot.title}</span>
                <span className="text-xs text-[var(--ui-text-muted)]">{remixSlot.action}</span>
              </>
            ) : (
              <>
                <span className="text-xs font-semibold">{emptyLabel}</span>
                {emptyHint ? <span className="text-xs text-[var(--ui-text-faint)]">{emptyHint}</span> : null}
              </>
            )}
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
          className="ui-focus-ring rounded-lg text-base font-bold leading-6 text-[var(--ui-text-primary)] outline-none sm:text-lg"
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
  /** Where the bar offers something else than Generate (a top-up, an image instead), Try again waits too. */
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
