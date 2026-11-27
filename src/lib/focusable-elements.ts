const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, audio[controls], video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * The controls Tab reaches inside a dialog, in order: what a modal viewer keeps the focus
 * among. Only the controls the browser draws: a folded <details> shows its summary alone,
 * and Tab skips the rest, so counting them let the focus out past the summary and sent
 * Shift+Tab to a control that cannot take it.
 */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute('aria-hidden') !== 'true'
      && !element.closest('details:not([open]) > :not(summary)')
      && (typeof element.checkVisibility !== 'function' || element.checkVisibility()));
}

/**
 * A modal's Tab: round its own controls, never on to the page under it. Called from the modal's
 * keydown listener with any key; it acts on Tab alone. A modal with no control keeps the focus on
 * itself, and a focus that has got out (a click on the page under it) comes back at the near end.
 * The studio's preview, the media details viewer, the canvas's preview and the composer's lightbox use it.
 */
export function keepTabInside(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!container.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
