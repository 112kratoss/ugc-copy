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
