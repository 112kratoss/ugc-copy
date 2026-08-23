'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AnchoredMenuPosition {
  top: number;
  left: number;
}

const MENU_GAP_PX = 8;

/**
 * Open/close state and viewport placement for a menu portaled to the body.
 *
 * The cards these menus sit in clip overflow for their rounded corners and
 * would cut a nested popover off after the first item, so the menu renders
 * at the body and is positioned from the trigger's rect. The position doubles
 * as the open state. A fixed menu cannot follow its trigger through a scroll
 * or resize, so either closes it; a pointer down outside the trigger or the
 * menu closes it too.
 */
export function useAnchoredMenu({
  align = 'start',
  width,
}: {
  align?: 'start' | 'end';
  width: number;
}) {
  const [position, setPosition] = useState<AnchoredMenuPosition | null>(null);
  const isOpen = position !== null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
    const preferredLeft = align === 'end' ? rect.right - width : rect.left;
    // Keep the menu inside the viewport on narrow screens.
    const left = Math.max(
      MENU_GAP_PX,
      Math.min(preferredLeft, window.innerWidth - width - MENU_GAP_PX),
    );
    setPosition({ top: rect.bottom + MENU_GAP_PX, left });
  }, [align, width]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
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

  return { isOpen, position, open, close, rootRef, triggerRef, menuRef };
}
