import type { ComponentPropsWithoutRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CreatorCanvasFrame,
  CreatorColumnBar,
  CreatorToolTabs,
  parseAspectRatio,
} from '@/components/CreatorColumn';

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));

function renderBar(status?: string) {
  return render(
    <div>
      <p>Outside the bar</p>
      <CreatorColumnBar
        settingsSummary="1K · AUTO · JPG"
        settings={<button type="button">16:9</button>}
        status={status}
        action={<button type="button">Generate · 8 credits</button>}
      />
    </div>
  );
}

/**
 * The image creator's column (2026-10-26): the app's composer on the web. Its bar
 * folds the run's settings into one chip that reads them back and opens them above
 * the bar, as the app's parameter sheet does.
 */
describe('the creator column bar', () => {
  it('reads the settings back on its chip and opens them from it', () => {
    renderBar();
    const chip = screen.getByRole('button', { name: 'Generation settings: 1K · AUTO · JPG' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'Generation settings' })).not.toBeInTheDocument();

    fireEvent.click(chip);

    const panel = screen.getByRole('dialog', { name: 'Generation settings' });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip).toHaveAttribute('aria-controls', panel.id);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
  });

  it('puts the settings away at Escape and gives the chip the focus back', async () => {
    renderBar();
    const chip = screen.getByRole('button', { name: /^Generation settings/ });
    fireEvent.click(chip);
    act(() => screen.getByRole('button', { name: '16:9' }).focus());

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveFocus();
  });

  it('keeps the settings open for a press inside them, and puts them away at any other', () => {
    renderBar();
    const chip = screen.getByRole('button', { name: /^Generation settings/ });
    fireEvent.click(chip);

    fireEvent.pointerDown(screen.getByRole('button', { name: '16:9' }));
    expect(chip).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(screen.getByText('Outside the bar'));
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Generate too: a run never starts under the panel.
    fireEvent.click(chip);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Generate · 8 credits' }));
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('says what stops a run above the action, and nothing when there is nothing to say', () => {
    const view = renderBar('Resolve the unknown element mention before generating: @lead');
    expect(screen.getByText(/^Resolve the unknown element mention/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate · 8 credits' })).toBeInTheDocument();

    view.unmount();
    renderBar();
    expect(screen.queryByText(/^Resolve/)).not.toBeInTheDocument();
  });

  it('draws no chip for a model with nothing to set', () => {
    render(<CreatorColumnBar settingsSummary="Settings" settings={null} action={<button type="button">Generate</button>} />);
    expect(screen.queryByRole('button', { name: /^Generation settings/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });
});

describe('the creator tool tabs', () => {
  it('names the creator open as the current page and links the other two', () => {
    render(<CreatorToolTabs currentToolId="image" />);
    const tabs = screen.getByRole('navigation', { name: 'Creator tools' });

    expect(screen.getByRole('link', { name: 'Image' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Video' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Motion' })).not.toHaveAttribute('aria-current');
    // The video creator is heavy: it is fetched when opened, not ahead of time.
    expect(screen.getByRole('link', { name: 'Video' })).toHaveAttribute('data-prefetch', 'false');
    expect(tabs.querySelectorAll('a')).toHaveLength(3);
  });
});

describe('the canvas frame', () => {
  it.each([
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['1:1', 1],
    ['21:9', 21 / 9],
  ])('reads %s as its ratio', (aspectRatio, ratio) => {
    expect(parseAspectRatio(aspectRatio)).toBeCloseTo(ratio);
  });

  it.each(['auto', '', '16x9', '0:1', '4:0'])('reads %j as no ratio', (aspectRatio) => {
    expect(parseAspectRatio(aspectRatio)).toBeNull();
  });

  it('takes the shape of the run, and a square for "auto"', () => {
    const view = render(<CreatorCanvasFrame aspectRatio="16:9">Empty</CreatorCanvasFrame>);
    expect(Number(screen.getByTestId('creator-canvas-frame').style.getPropertyValue('--creator-frame-ratio'))).toBeCloseTo(16 / 9);

    view.rerender(<CreatorCanvasFrame aspectRatio="auto">Empty</CreatorCanvasFrame>);
    expect(screen.getByTestId('creator-canvas-frame').style.getPropertyValue('--creator-frame-ratio')).toBe('1');
  });
});
