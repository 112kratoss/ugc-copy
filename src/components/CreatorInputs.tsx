'use client';

import clsx from 'clsx';
import { useId, useRef, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

import { getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { useModalQuestion } from '@/components/useModalQuestion';
import type { VideoInputQuestion, VideoInputSide } from '@/lib/creator-video-inputs';

/**
 * The column's inputs (the artboard Inputs, PR 4 of the creator redesign): one card with its
 * kicker, the frames/references switch where the model takes both, the line that says what the
 * side shown does, and that side's slots.
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

const SIDES: readonly VideoInputSide[] = ['frames', 'references'];

/**
 * Frames or references: a pair of radios in a pill, named by its legend ("Start from frames or
 * references"). The parent decides whether a pick takes effect: a pick that would clear
 * something asks first, and until the answer the radios stay on the side shown.
 */
export function CreatorInputSwitch({ legend, labels, value, onChange, accent = 'video', ref }: {
  legend: string;
  labels: Record<VideoInputSide, string>;
  value: VideoInputSide;
  onChange: (side: VideoInputSide) => void;
  accent?: UiAccent;
  /** The parent gives the focus back to the side shown when its question goes. */
  ref?: Ref<HTMLFieldSetElement>;
}) {
  const name = useId();
  const selected = getAccentClasses(accent).selected;
  return (
    <fieldset ref={ref} className="inline-flex shrink-0 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-1">
      <legend className="sr-only">{legend}</legend>
      {SIDES.map((side) => {
        const checked = side === value;
        return (
          <label
            key={side}
            className={clsx(
              'relative inline-flex min-h-10 cursor-pointer items-center rounded-full border px-3.5 text-xs font-bold transition-colors duration-150',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]/55 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--ui-bg-app)]',
              checked
                ? selected
                : 'border-transparent text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-secondary)]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={side}
              checked={checked}
              onChange={() => onChange(side)}
              className="sr-only"
            />
            {labels[side]}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * The question a switch asks before it clears something (the artboard Inputs: "Switch to
 * references?"). Modal, as the creators' other questions are: the page beneath is inert, Tab
 * stays in it, Escape and a Back off the page keep the side shown, and the focus goes back
 * where it was. The safe choice comes first and takes the focus, so Enter never clears by
 * accident.
 */
export function CreatorInputSwitchDialog(props: {
  question: VideoInputQuestion;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(<CreatorInputSwitchPanel {...props} />, document.body);
}

function CreatorInputSwitchPanel({ question, onKeep, onConfirm }: {
  question: VideoInputQuestion;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // First: the focus useModalQuestion gives back as the question goes does nothing while
  // the page beneath is still inert, and effects are undone in the order they were declared.
  useInertPageBeneath(overlayRef);
  useModalQuestion({
    questionId: 1,
    dialogRef,
    initialFocus: () => keepRef.current,
    focusables: () => [keepRef.current, confirmRef.current].filter((control): control is HTMLButtonElement => control !== null),
    onCancel: onKeep,
  });

  return (
    <div
      ref={overlayRef}
      className="ui-confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onKeep();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        className="ui-confirm-dialog"
      >
        <h2 id={`${id}-title`} className="ui-confirm-title">{question.title}</h2>
        <p id={`${id}-message`} className="ui-confirm-message">{question.message}</p>
        <div className="ui-confirm-actions">
          <button ref={keepRef} type="button" onClick={onKeep} className="ui-button ui-button-secondary ui-focus-ring">
            {question.keepLabel}
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} className="ui-button ui-button-primary ui-focus-ring">
            {question.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
