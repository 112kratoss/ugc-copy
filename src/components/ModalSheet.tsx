'use client';

import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { useModalQuestion } from '@/components/useModalQuestion';

const FOCUSABLE = 'a[href], button:not([disabled])';

/**
 * A sheet over the page it is drawn on (the creators' sign-up at Generate, the Top Up a short
 * balance opens), on the confirm surface: its title with Close beside it, a line under the
 * title, then what the sheet holds. The page beneath takes no press or key while it is up.
 * Escape, Close and the backdrop put it away unless it is `locked`, while something it started
 * must be left to finish. The backdrop takes no second click of a double-click: its first, on
 * what opened the sheet, brought the sheet up under the pointer.
 */
export function ModalSheet({ title, body, initialFocusRef, locked = false, spare, onClose, children }: {
  title: ReactNode;
  body: ReactNode;
  /** What has the focus as the sheet comes up. */
  initialFocusRef: RefObject<HTMLElement | null>;
  locked?: boolean;
  /** Children of <body> that stay live under the sheet (`useInertPageBeneath`): a function made once. */
  spare?: (element: HTMLElement) => boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // First: the focus useModalQuestion gives back as the sheet goes does nothing
  // while the page beneath is still inert, and effects are undone in order.
  useInertPageBeneath(overlayRef, { spare });
  useModalQuestion({
    questionId: 1,
    dialogRef: panelRef,
    initialFocus: () => initialFocusRef.current,
    focusables: () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    onCancel: () => {
      if (!locked) onClose();
    },
  });

  return (
    <div
      ref={overlayRef}
      className="ui-confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && event.detail < 2 && !locked) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="ui-confirm-dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="ui-confirm-title">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            aria-label="Close"
            title="Close"
            className="ui-icon-button ui-focus-ring -mr-2 -mt-2 shrink-0 disabled:opacity-50"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <p id={bodyId} className="ui-confirm-message">{body}</p>
        {children}
      </div>
    </div>
  );
}
