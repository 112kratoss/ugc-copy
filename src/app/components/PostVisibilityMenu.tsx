'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Globe, Link2, Loader2, LockKeyhole } from 'lucide-react';

import type { PostVisibility } from '@/lib/post-lifecycle-client';

export const POST_VISIBILITY_OPTIONS: ReadonlyArray<{
  value: PostVisibility;
  label: string;
  hint: string;
  Icon: typeof Globe;
}> = [
  { value: 'public', label: 'Public', hint: 'In the showcase and feed.', Icon: Globe },
  { value: 'unlisted', label: 'Unlisted', hint: 'Only people with the link.', Icon: Link2 },
  { value: 'private', label: 'Private', hint: 'Only you.', Icon: LockKeyhole },
];

const TRIGGER_TONE_CLASS: Record<PostVisibility, string> = {
  public: 'border-sky-400/25 bg-sky-500/10 text-sky-100 hover:border-sky-300/35 hover:bg-sky-500/15',
  unlisted: 'border-violet-400/25 bg-violet-500/10 text-violet-100 hover:border-violet-300/35 hover:bg-violet-500/15',
  private: 'border-white/12 bg-white/[0.05] text-zinc-200 hover:border-white/20 hover:bg-white/[0.08]',
};

interface PostVisibilityMenuProps {
  value: PostVisibility;
  onChange: (next: PostVisibility) => void;
  disabled?: boolean;
  /** A change is in flight: the trigger shows a spinner and stays disabled. */
  pending?: boolean;
  /** Which edge of the trigger the menu aligns to. */
  align?: 'start' | 'end';
  /** Accessible name for the trigger, e.g. "Visibility of Sunset study". */
  label?: string;
  size?: 'sm' | 'md';
}

const MENU_WIDTH_PX = 256;
const MENU_GAP_PX = 8;

interface MenuPosition {
  top: number;
  left: number;
}

/**
 * The one visibility control for an owned post: a trigger showing the
 * current state and a menu of the three states with what each means.
 * Rendered on the showcase detail page and in Studio, so it avoids responsive
 * display utilities (see the CSS note in globals.css).
 *
 * The menu is portaled to the body and positioned from the trigger's rect:
 * the cards it sits in clip overflow for their rounded corners and would cut
 * a nested popover off after the first item.
 */
export default function PostVisibilityMenu({
  value,
  onChange,
  disabled = false,
  pending = false,
  align = 'start',
  label = 'Change visibility',
  size = 'md',
}: PostVisibilityMenuProps) {
  // The menu's viewport position doubles as its open state.
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const isOpen = position !== null;
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, POST_VISIBILITY_OPTIONS.findIndex((option) => option.value === value)),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const current = POST_VISIBILITY_OPTIONS.find((option) => option.value === value) ?? POST_VISIBILITY_OPTIONS[0];
  const isInert = disabled || pending;

  const close = useCallback((restoreFocus: boolean) => {
    setPosition(null);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const open = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const preferredLeft = align === 'end' ? rect.right - MENU_WIDTH_PX : rect.left;
    // Keep the menu inside the viewport on narrow screens.
    const left = Math.max(
      MENU_GAP_PX,
      Math.min(preferredLeft, window.innerWidth - MENU_WIDTH_PX - MENU_GAP_PX),
    );
    setActiveIndex(Math.max(0, POST_VISIBILITY_OPTIONS.findIndex((option) => option.value === value)));
    setPosition({ top: rect.bottom + MENU_GAP_PX, left });
  }, [align, value]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Opening lands focus on the current state; arrow keys move it from there.
    const currentIndex = Math.max(0, POST_VISIBILITY_OPTIONS.findIndex((option) => option.value === value));
    const frame = window.requestAnimationFrame(() => itemRefs.current[currentIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, value]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // The menu is fixed to the viewport, so any scroll or resize moves the
    // trigger out from under it; closing is simpler than tracking it.
    const handleViewportChange = () => close(false);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [close, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [close, isOpen]);

  const moveActive = (delta: number) => {
    const count = POST_VISIBILITY_OPTIONS.length;
    const nextIndex = (activeIndex + delta + count) % count;
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  const choose = (next: PostVisibility) => {
    close(true);
    if (next !== value) {
      onChange(next);
    }
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        itemRefs.current[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(POST_VISIBILITY_OPTIONS.length - 1);
        itemRefs.current[POST_VISIBILITY_OPTIONS.length - 1]?.focus();
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        break;
    }
  };

  const triggerSizeClass = size === 'sm'
    ? 'px-3 py-2 text-xs font-medium'
    : 'px-3.5 py-2 text-sm font-medium';
  const CurrentIcon = current.Icon;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={`${label}: ${current.label}`}
        disabled={isInert}
        onClick={() => (isOpen ? close(false) : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open();
          }
        }}
        className={`ui-focus-ring inline-flex items-center gap-2 rounded-full border transition disabled:cursor-not-allowed disabled:opacity-60 ${triggerSizeClass} ${TRIGGER_TONE_CLASS[value]}`}
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <CurrentIcon className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{current.label}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
      </button>

      {isOpen && position ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          style={{ top: position.top, left: position.left, width: MENU_WIDTH_PX }}
          className="fixed z-[90] rounded-2xl border border-white/10 bg-[var(--ui-surface-1)] p-1.5 shadow-[var(--ui-shadow-panel)]"
        >
          {POST_VISIBILITY_OPTIONS.map((option, index) => {
            const isSelected = option.value === value;
            const OptionIcon = option.Icon;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => choose(option.value)}
                onFocus={() => setActiveIndex(index)}
                className={`ui-focus-ring flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                  isSelected ? 'bg-white/[0.08] text-white' : 'text-zinc-200 hover:bg-white/[0.05] hover:text-white'
                }`}
              >
                <OptionIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-5">{option.label}</span>
                  <span className="block text-xs leading-5 text-zinc-400">{option.hint}</span>
                </span>
                {isSelected ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
