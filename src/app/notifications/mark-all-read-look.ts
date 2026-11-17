/**
 * Mark all read's looks, shared by the button (`SignedInAlerts.tsx`) and the outline that holds its
 * place while the signed-in half loads (`page.tsx`), so the button arrives looking as its outline
 * did. At rest (nothing unread, or no count read yet) it cannot be pressed and is drawn plainly
 * off: no fill, faint words, and no answer to a pointer. It was drawn at 40% opacity and lit up
 * under a pointer like a button that could act, from before the count was known (live, 2026-11-17).
 */
export const MARK_ALL_READ_SHAPE =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-full border px-4 text-sm font-bold';

export const MARK_ALL_READ_AT_REST = 'border-[var(--ui-border-subtle)] bg-transparent text-[var(--ui-text-faint)]';

/** Something is unread. Pressed, it stays this way, with a spinner, until the write answers. */
export const MARK_ALL_READ_ON_OFFER =
  'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] transition enabled:hover:bg-[var(--ui-surface-3)] enabled:hover:text-[var(--ui-text-primary)]';
