'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Loader2, MoreHorizontal } from 'lucide-react';

import { useAnchoredMenu } from '@/app/components/useAnchoredMenu';

export type StudioOverflowMenuTone = 'default' | 'success' | 'warning' | 'danger';

export interface StudioOverflowMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Navigates instead of calling onSelect. */
  href?: string;
  /** Renders an anchor that saves the target under this file name. */
  download?: string;
  onSelect?: () => void;
  tone?: StudioOverflowMenuTone;
  disabled?: boolean;
  /** The action is in flight: shows a spinner and stays disabled. */
  pending?: boolean;
}

interface StudioOverflowMenuProps {
  /** Accessible name for the trigger, e.g. "More actions for Sunset study". */
  label: string;
  items: StudioOverflowMenuItem[];
  align?: 'start' | 'end';
  disabled?: boolean;
}

const MENU_WIDTH_PX = 240;

const ITEM_TONE_CLASS: Record<StudioOverflowMenuTone, string> = {
  default: 'text-zinc-200 hover:bg-white/[0.05] hover:text-white',
  success: 'text-emerald-100 hover:bg-emerald-500/10',
  warning: 'text-amber-100 hover:bg-amber-500/10',
  danger: 'text-rose-100 hover:bg-rose-500/10',
};

/**
 * The secondary actions of a Studio card behind one "more" trigger, the way
 * the mobile app keeps them in its action sheet: the card shows its state and
 * its one or two primary actions, and everything else — download, archive,
 * delete, restore — lives here instead of as a row of coloured icon buttons.
 *
 * Menu semantics match PostVisibilityMenu: arrow keys move between items,
 * Home/End jump, Escape closes and restores focus, Tab closes.
 */
export default function StudioOverflowMenu({
  label,
  items,
  align = 'end',
  disabled = false,
}: StudioOverflowMenuProps) {
  const { isOpen, position, open, close, rootRef, triggerRef, menuRef } = useAnchoredMenu({
    align,
    width: MENU_WIDTH_PX,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  if (items.length === 0) {
    return null;
  }

  const moveActive = (delta: number) => {
    const count = items.length;
    const nextIndex = (activeIndex + delta + count) % count;
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
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
        setActiveIndex(items.length - 1);
        itemRefs.current[items.length - 1]?.focus();
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

  const itemClass = (item: StudioOverflowMenuItem) =>
    `ui-focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${ITEM_TONE_CLASS[item.tone ?? 'default']}`;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => {
          if (isOpen) {
            close(false);
            return;
          }
          setActiveIndex(0);
          open();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(0);
            open();
          }
        }}
        className="ui-focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
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
          {items.map((item, index) => {
            const icon = item.pending
              ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              : item.icon
                ? <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">{item.icon}</span>
                : null;
            const body = (
              <>
                {icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </>
            );
            const isInert = Boolean(item.disabled || item.pending);
            const sharedProps = {
              role: 'menuitem' as const,
              tabIndex: index === activeIndex ? 0 : -1,
              onFocus: () => setActiveIndex(index),
              className: itemClass(item),
            };

            if (item.href && !isInert) {
              const isDownload = Boolean(item.download);
              if (isDownload) {
                return (
                  <a
                    key={item.key}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    href={item.href}
                    download={item.download}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => close(false)}
                    {...sharedProps}
                  >
                    {body}
                  </a>
                );
              }
              return (
                <Link
                  key={item.key}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  href={item.href}
                  onClick={() => close(false)}
                  {...sharedProps}
                >
                  {body}
                </Link>
              );
            }

            return (
              <button
                key={item.key}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                disabled={isInert}
                onClick={() => {
                  close(true);
                  item.onSelect?.();
                }}
                {...sharedProps}
              >
                {body}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
