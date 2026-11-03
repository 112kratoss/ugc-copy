'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { ImageIcon, Play } from 'lucide-react';

import { StudioElementHandle } from '@/components/CreatorStudio';
import { extractPromptHandles } from '@/lib/image-elements';
import { measureTextareaCaret, placeMentionMenu } from '@/lib/textarea-caret';

export type CreatorMentionSuggestion = {
  id: string;
  displayName: string;
  handle: string;
  kind?: 'image' | 'video';
  /** The picture, or the clip whose first moment is shown. */
  previewUrl?: string | null;
};

/** The mention being typed at the caret (`getMentionQueryAtCaret`). */
export type CreatorMention = { query: string; replaceStart: number; replaceEnd: number };

// The menu's own limits, as `max-h-72` and `22rem`: past the height its rows scroll.
const MENU_MAX_HEIGHT = 288;
const MENU_WIDTH = 352;

/**
 * The "@" menu's state and keys for one prompt, or for one group of prompts that
 * take turns (a multi-shot run's shots).
 *
 * The menu is open while the page has a mention at the caret, the prompt has the
 * focus, and the creator has not put it away with Escape. Escape keeps it shut for
 * that "@" until the caret leaves it. Up and Down move through the rows, Enter or
 * Tab puts the row in, as in a chat app's mention menu, and the focus never leaves
 * the prompt: the rows are the prompt's options (`aria-activedescendant`).
 *
 * A handle put in leaves the caret right after it, which reads as a mention being
 * typed, so the keyup of the Enter that put it in is not taken for a caret move:
 * the menu would open again on the handle it had just put in.
 */
export function useCreatorMentionMenu<T extends CreatorMentionSuggestion>({
  mention,
  suggestions,
  onInsert,
}: {
  /** The page's mention at the caret, or null where the prompt offers none. */
  mention: CreatorMention | null;
  suggestions: readonly T[];
  onInsert: (handle: string) => void;
}) {
  const listboxId = useId();
  const [blurred, setBlurred] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  const takenKeyUp = useRef<string | null>(null);

  // A new query starts at the first row; a caret that left the "@" ends Escape's hold on it.
  const key = mention ? `${mention.replaceStart}:${mention.query}` : null;
  if (key !== trackedKey) {
    setTrackedKey(key);
    setActiveIndex(0);
    if (!mention && dismissedAt !== null) setDismissedAt(null);
  }

  const open = mention !== null && !blurred && mention.replaceStart !== dismissedAt;
  const active = suggestions.length > 0 ? Math.min(activeIndex, suggestions.length - 1) : -1;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    takenKeyUp.current = null;
    if (!open || !mention || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedAt(mention.replaceStart);
      return;
    }
    const count = suggestions.length;
    if (count === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (Math.min(current, count - 1) + step + count) % count);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      takenKeyUp.current = event.key;
      onInsert(suggestions[active].handle);
    }
  };

  return {
    open,
    /**
     * The prompt's handlers and ARIA. `onCaretMove` is the page's own check for a
     * mention at the caret; `owns` says this prompt is the one the open menu is for.
     */
    field: ({ onCaretMove, onFocus, owns = true }: { onCaretMove: () => void; onFocus?: () => void; owns?: boolean }) => ({
      onClick: onCaretMove,
      onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (takenKeyUp.current === event.key) {
          takenKeyUp.current = null;
          return;
        }
        onCaretMove();
      },
      onKeyDown: owns ? onKeyDown : undefined,
      onFocus: () => {
        setBlurred(false);
        onFocus?.();
      },
      onBlur: () => setBlurred(true),
      'aria-autocomplete': 'list' as const,
      // The list is drawn only while it has rows.
      'aria-controls': owns && open && active >= 0 ? listboxId : undefined,
      'aria-activedescendant': owns && open && active >= 0 ? optionId(active) : undefined,
    }),
    menu: {
      listboxId,
      optionId,
      mention,
      suggestions,
      activeIndex: active,
      onActivate: setActiveIndex,
      onPick: onInsert,
    },
  };
}

/**
 * The "@" menu: drawn over the page under the line the mention is typed on (or
 * over that line where the window has more room there), with each reference's
 * picture, name and @handle, and "In prompt" for one the prompt already names, as
 * the app's list has them. It is placed from where the textarea draws the "@",
 * inside the nearest positioned box around it (the prompt's card), so the page's
 * own markup around the textarea stays as it was.
 *
 * A row's name is cut to one line and its handle keeps its whole width, breaking
 * only after an underscore where no line holds it, as on a reference card.
 */
export function CreatorMentionMenu<T extends CreatorMentionSuggestion>({
  menu,
  field,
  noun,
  prompt,
  handleClassName,
}: {
  menu: ReturnType<typeof useCreatorMentionMenu<T>>['menu'];
  /** The textarea the mention is typed in. */
  field: () => HTMLTextAreaElement | null;
  /** What a row is, in the singular: "reference", "video element", "subject". */
  noun: string;
  /** The prompt's text, for which rows it already names. */
  prompt: string;
  /** A row's handle colour: on the video creator a clip's differs from a picture's. */
  handleClassName: (suggestion: T) => string;
}) {
  const { listboxId, optionId, mention, suggestions, activeIndex, onActivate, onPick } = menu;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef(field);
  const replaceStart = mention?.replaceStart ?? 0;

  useLayoutEffect(() => {
    fieldRef.current = field;
  });

  // Placed by hand, as a tooltip is: from the field's layout, before the browser paints.
  useLayoutEffect(() => {
    const place = () => {
      const root = rootRef.current;
      const textarea = fieldRef.current();
      if (!root || !textarea) return;
      const width = Math.min(MENU_WIDTH, textarea.offsetWidth);
      root.style.width = `${width}px`;
      const caret = measureTextareaCaret(textarea, replaceStart);
      // A caret scrolled out of the field hangs the menu from the field's nearer edge.
      caret.top = Math.min(Math.max(caret.top, 0), Math.max(textarea.offsetHeight - caret.height, 0));
      const list = listRef.current;
      const menuHeight = Math.min(
        list ? root.offsetHeight - list.clientHeight + list.scrollHeight : root.offsetHeight,
        MENU_MAX_HEIGHT,
      );
      const fieldBox = textarea.getBoundingClientRect();
      const view = visibleBounds();
      const placement = placeMentionMenu({
        caret,
        fieldWidth: textarea.offsetWidth,
        menuWidth: width,
        menuHeight,
        room: {
          above: fieldBox.top + caret.top - view.top,
          below: view.bottom - (fieldBox.top + caret.top + caret.height),
        },
      });
      // From the field's corner to the corner of the box the menu is placed in.
      const box = root.offsetParent instanceof HTMLElement ? root.offsetParent : null;
      const boxRect = box?.getBoundingClientRect();
      const x = fieldBox.left - (boxRect?.left ?? 0) - (box?.clientLeft ?? 0);
      const y = fieldBox.top - (boxRect?.top ?? 0) - (box?.clientTop ?? 0);
      root.style.left = `${x + placement.left}px`;
      root.style.top = `${y + placement.top}px`;
      root.style.maxHeight = placement.maxHeight === null ? '' : `${placement.maxHeight}px`;
      root.style.visibility = 'visible';
      root.dataset.side = placement.side;
    };
    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [replaceStart, prompt, suggestions.length]);

  // The row the keys reach stays in view inside the list.
  useEffect(() => {
    const list = listRef.current;
    const option = activeIndex >= 0 ? list?.children[activeIndex] as HTMLElement | undefined : undefined;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) {
      list.scrollTop = option.offsetTop;
    } else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [activeIndex]);

  if (!mention) return null;

  const plural = `${noun}s`;
  const title = plural.charAt(0).toUpperCase() + plural.slice(1);
  const count = `${suggestions.length} ${suggestions.length === 1 ? noun : plural}`;
  // The prompt without the mention being typed: a handle typed out in full is that
  // mention, not one the prompt already holds.
  const named = new Set(extractPromptHandles(prompt.slice(0, mention.replaceStart) + prompt.slice(mention.replaceEnd)));

  return (
    <div
      ref={rootRef}
      data-mention-menu=""
      // Pressing a row or the list's scrollbar keeps the focus, and the caret, in the prompt.
      onMouseDown={(event) => event.preventDefault()}
      className="invisible absolute left-0 top-0 z-40 flex max-h-72 w-[min(22rem,100%)] flex-col overflow-hidden rounded-ui-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)] shadow-[var(--shadow-ui-panel)]"
    >
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--ui-border-subtle)] px-4">
        <p id={`${listboxId}-title`} className="text-xs font-extrabold text-[var(--ui-text-secondary)]">{title}</p>
        <p aria-live="polite" className="text-[11px] font-bold tabular-nums text-[var(--ui-text-faint)]">{count}</p>
      </div>
      {suggestions.length > 0 ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={`${listboxId}-title`}
          className="relative min-h-0 overflow-y-auto overscroll-contain p-1.5 app-scrollbar"
        >
          {suggestions.map((suggestion, index) => {
            const inPrompt = named.has(suggestion.handle);
            return (
              <button
                key={suggestion.id}
                id={optionId(index)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                aria-label={`Insert ${suggestion.handle}, ${suggestion.displayName}${inPrompt ? ', already in the prompt' : ''}`}
                onMouseMove={() => {
                  if (index !== activeIndex) onActivate(index);
                }}
                onClick={() => onPick(suggestion.handle)}
                className={clsx(
                  'flex min-h-14 w-full items-center gap-3 rounded-ui-lg px-2.5 py-2 text-left transition-colors duration-100',
                  index === activeIndex && 'bg-[var(--ui-surface-3)]',
                )}
              >
                <MentionPreview kind={suggestion.kind} src={suggestion.previewUrl} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-bold text-[var(--ui-text-primary)]">{suggestion.displayName}</span>
                  <StudioElementHandle handle={suggestion.handle} className={clsx('text-xs font-bold', handleClassName(suggestion))} />
                </span>
                {inPrompt ? (
                  <span className="shrink-0 text-[11px] font-bold text-[var(--ui-text-muted)]">In prompt</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p aria-live="polite" className="px-4 py-4 text-xs leading-5 text-[var(--ui-text-muted)]">
          {mention.query ? (
            // What was typed is a box of its own, quotes and stop inside it: it moves to the next
            // line whole while a line holds it, and breaks after an underscore only where none does.
            <>No {plural} match <StudioElementHandle handle={`“@${mention.query}”.`} className="inline-block max-w-full" /></>
          ) : (
            `Add a ${noun} to mention it here.`
          )}
        </p>
      )}
    </div>
  );
}

/** A row's picture, or its clip's first moment, small and still. */
function MentionPreview({ kind = 'image', src }: { kind?: 'image' | 'video'; src?: string | null }) {
  return (
    <span aria-hidden className="relative block h-10 w-10 shrink-0 overflow-hidden rounded-ui-sm border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)]">
      {src ? (
        kind === 'video' ? (
          <video src={`${src}#t=0.1`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
        ) : (
          // A local upload's blob: address cannot go through the image optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        )
      ) : (
        <ImageIcon className="absolute inset-0 m-auto h-4 w-4 text-[var(--ui-text-faint)]" />
      )}
      {kind === 'video' ? <Play className="absolute bottom-0.5 right-0.5 h-3 w-3 text-white/90" /> : null}
    </span>
  );
}

/** The part of the window the page shows: under the shell's top bar, over the creator's bar and any keyboard. */
function visibleBounds() {
  const viewport = window.visualViewport;
  let top = viewport ? viewport.offsetTop : 0;
  let bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const header = document.querySelector('.app-shell-header');
  if (header) top = Math.max(top, header.getBoundingClientRect().bottom);
  const bar = document.querySelector('[data-creator-bar]');
  if (bar) {
    const barTop = bar.getBoundingClientRect().top;
    if (barTop > top) bottom = Math.min(bottom, barTop);
  }
  return { top, bottom };
}
