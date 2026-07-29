// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailOverlay from '@/app/showcase/[id]/ShowcaseDetailOverlay';

const back = vi.fn();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back, replace }),
}));

function renderOverlay(children: React.ReactNode = <button type="button">Inner action</button>) {
  return render(
    <ShowcaseDetailOverlay title="Moody Bathroom Portrait Study">{children}</ShowcaseDetailOverlay>,
  );
}

/** jsdom reports a single entry; an intercepted overlay always has more. */
function withHistoryEntries(length: number) {
  Object.defineProperty(window.history, 'length', { value: length, configurable: true });
}

describe('ShowcaseDetailOverlay', () => {
  beforeEach(() => {
    back.mockReset();
    replace.mockReset();
    document.body.style.overflow = '';
    withHistoryEntries(2);
  });

  it('exposes the post as a labelled modal dialog', () => {
    renderOverlay();

    const dialog = screen.getByRole('dialog', { name: 'Moody Bathroom Portrait Study' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close post' })).toBeInTheDocument();
  });

  it('steps back in history on close, Escape, and backdrop click', () => {
    const { unmount } = renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Close post' }));
    expect(back).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(back).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('showcase-detail-overlay'));
    expect(back).toHaveBeenCalledTimes(3);
    expect(replace).not.toHaveBeenCalled();

    unmount();
  });

  it('navigates instead of stepping back when there is no history to consume', () => {
    withHistoryEntries(1);
    renderOverlay();

    fireEvent.click(screen.getByRole('button', { name: 'Close post' }));

    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/showcase');
  });

  it('keeps the overlay open when the click lands inside the panel', () => {
    renderOverlay();

    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Inner action' }));

    expect(back).not.toHaveBeenCalled();
  });

  it('lets a nested dialog own Escape while it is open', () => {
    renderOverlay(
      <div data-showcase-overlay-nested="true">
        <button type="button">Report</button>
      </div>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(back).not.toHaveBeenCalled();
  });

  it('marks the document so a reel viewer underneath yields Escape to the top layer', () => {
    const { unmount } = renderOverlay();

    expect(document.body.dataset.showcaseOverlayOpen).toBe('true');

    unmount();
    expect(document.body.dataset.showcaseOverlayOpen).toBeUndefined();
  });

  it('locks body scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = renderOverlay();

    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('cycles focus inside the panel', () => {
    renderOverlay(
      <>
        <button type="button">First</button>
        <button type="button">Last</button>
      </>,
    );

    const closeButton = screen.getByRole('button', { name: 'Close post' });
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
