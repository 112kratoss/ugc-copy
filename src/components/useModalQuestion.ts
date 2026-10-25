'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** The page an address names: a change of hash alone stays on it. */
function readAddress() {
  return `${window.location.pathname}${window.location.search}`;
}

interface ModalQuestionOptions {
  /** The id of the question on screen: a new one starts over. */
  questionId: number;
  dialogRef: RefObject<HTMLElement | null>;
  /** What takes the focus as the question appears. */
  initialFocus: () => HTMLElement | null | undefined;
  /** The controls Tab cycles through, first to last. */
  focusables: () => HTMLElement[];
  /** Escape, or a Back that leaves the page. Read when it happens, so it can decline (a save under way). */
  onCancel: () => void;
}

/**
 * What a question drawn over the page does while it is up, for
 * `FeedbackViewport`'s confirmation and the name-and-handle question alike.
 *
 * - Every key is the question's: heard first (on the window, in the capture
 *   phase) and kept from everything beneath it, so a modal under it never
 *   takes its Escape for its own or pulls Tab back into itself. Typing still
 *   reaches a field; its changes arrive as input events.
 * - Tab cycles through its own controls, and Escape puts it away.
 * - A Back that leaves the address it was asked at has left the page the
 *   question was about, and puts it away too; a change of hash does not.
 * - The focus goes in without scrolling (a phone's sheet starts below the
 *   window, and focusing it there jumped it into place in one frame instead
 *   of sliding up), and back to where it was when the question goes.
 */
export function useModalQuestion({ questionId, dialogRef, initialFocus, focusables, onCancel }: ModalQuestionOptions) {
  const latest = useRef({ initialFocus, focusables, onCancel });
  useEffect(() => {
    latest.current = { initialFocus, focusables, onCancel };
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      latest.current.initialFocus()?.focus({ preventScroll: true });
    });
    const askedAt = readAddress();

    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        latest.current.onCancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const controls = latest.current.focusables();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    const handlePopState = () => {
      if (readAddress() !== askedAt) {
        latest.current.onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('popstate', handlePopState);
      previouslyFocused?.focus();
    };
  }, [dialogRef, questionId]);
}
