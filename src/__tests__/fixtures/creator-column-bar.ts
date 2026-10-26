import { fireEvent, screen } from '@testing-library/react';

/**
 * The creators' column bar as the page tests drive it (image, video and motion share
 * it since 2026-10-26): Generate, named with the run's price whatever its face says,
 * and the run's settings, which its chip folds away.
 */
export function generateButton() {
  return screen.getByRole('button', { name: /^Generate · / });
}

export function queryGenerateButton() {
  return screen.queryByRole('button', { name: /^Generate · / });
}

/** The price Generate names, or why it waits ("Calculating..."); undefined while it is not there. */
export function costShown() {
  return queryGenerateButton()?.getAttribute('aria-label')?.replace(/^Generate · /, '');
}

/** Opens the settings the chip folds away, unless they are open: a press on the open chip shuts them. */
export function openSettings() {
  if (!screen.queryByRole('dialog', { name: 'Generation settings' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Generation settings/ }));
  }
}

/** A run setting (a ratio, a quality), chosen in the settings panel. */
export function chooseSetting(name: string) {
  openSettings();
  fireEvent.click(screen.getByRole('radio', { name }));
}
