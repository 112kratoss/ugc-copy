import type { ComponentPropsWithoutRef } from 'react';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_FRAME_RATIO_LIMITS,
  CreatorCanvas,
  CreatorCanvasFrame,
  CreatorCanvasMedia,
  CreatorColumnBar,
  CreatorColumnLayout,
  CreatorPhoneBalance,
  CreatorSettingChoices,
  CreatorSettingSwitch,
  CreatorTemplatesTile,
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
      <button type="button">Outside the bar</button>
      <CreatorColumnBar
        settingsSummary="1K · AUTO · JPG"
        settings={<button type="button">16:9</button>}
        status={status}
        action={<button type="button">Generate · 8 credits</button>}
      />
    </div>
  );
}

function settingsChip() {
  return screen.getByRole('button', { name: /^Generation settings/ });
}

/**
 * The image creator's column (2026-10-26): the app's composer on the web. Its bar
 * folds the run's settings into one chip that reads them back and opens them above
 * the bar, as the app's parameter sheet does.
 */
describe('the creator column bar', () => {
  it('reads the settings back on its chip, opens them from it and moves the focus in', () => {
    renderBar();
    const chip = screen.getByRole('button', { name: 'Generation settings: 1K · AUTO · JPG' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: 'Generation settings' })).not.toBeInTheDocument();

    fireEvent.click(chip);

    const panel = screen.getByRole('dialog', { name: 'Generation settings' });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip).toHaveAttribute('aria-controls', panel.id);
    // A keyboard press opens it and the next Tab goes into it, not on to Generate.
    expect(panel).toHaveFocus();
    expect(within(panel).getByRole('button', { name: '16:9' })).toBeInTheDocument();
  });

  it('comes after the bar in the page, so Tab from Generate reaches it', () => {
    renderBar();
    fireEvent.click(settingsChip());
    const panel = screen.getByRole('dialog', { name: 'Generation settings' });
    const generate = screen.getByRole('button', { name: 'Generate · 8 credits' });

    expect(generate.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the settings away at an Escape inside them and gives the chip the focus back', () => {
    renderBar();
    fireEvent.click(settingsChip());

    fireEvent.keyDown(screen.getByRole('button', { name: '16:9' }), { key: 'Escape' });

    expect(settingsChip()).toHaveAttribute('aria-expanded', 'false');
    expect(settingsChip()).toHaveFocus();
  });

  it('leaves an Escape pressed elsewhere on the page to whatever it belongs to', () => {
    renderBar();
    fireEvent.click(settingsChip());

    fireEvent.keyDown(screen.getByRole('button', { name: 'Outside the bar' }), { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(settingsChip()).toHaveAttribute('aria-expanded', 'true');
  });

  it('puts the settings away when the focus leaves them', () => {
    renderBar();
    fireEvent.click(settingsChip());
    const panel = screen.getByRole('dialog', { name: 'Generation settings' });

    // Within the panel, it stays.
    fireEvent.blur(panel, { relatedTarget: within(panel).getByRole('button', { name: '16:9' }) });
    expect(settingsChip()).toHaveAttribute('aria-expanded', 'true');

    // Out to Generate, as Shift+Tab from its first control goes, it closes.
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: 'Generate · 8 credits' }) });
    expect(settingsChip()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the settings open for a press inside them, and puts them away at any other', () => {
    renderBar();
    const chip = settingsChip();
    fireEvent.click(chip);

    fireEvent.pointerDown(screen.getByRole('button', { name: '16:9' }));
    expect(chip).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside the bar' }));
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Generate too: a run never starts under the panel.
    fireEvent.click(chip);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Generate · 8 credits' }));
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('says what stops a run above the buttons, and draws no line at all when there is nothing to say', () => {
    const { container, unmount } = renderBar('Resolve the unknown element mention before generating: @lead');
    const line = container.querySelector('[data-creator-bar-status]');
    expect(line).toHaveTextContent(/^Resolve the unknown element mention/);
    const generate = screen.getByRole('button', { name: 'Generate · 8 credits' });
    expect(line!.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    const quiet = renderBar();
    expect(quiet.container.querySelector('[data-creator-bar-status]')).toBeNull();
  });

  it('draws no chip for a model with nothing to set', () => {
    render(<CreatorColumnBar settingsSummary="Settings" settings={null} action={<button type="button">Generate</button>} />);
    expect(screen.queryByRole('button', { name: /^Generation settings/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
  });

  it('stays above the bottom navigation on a phone', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[data-creator-bar]');
    // The shell's room for the bottom navigation, 0px from 768px; without it the nav took Generate's taps.
    expect(bar?.className).toContain('bottom-[calc(var(--app-shell-bottom-nav-space,0px)+0.75rem)]');
    expect(bar?.className).toContain('sticky');
  });
});

describe('the creator column', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The browser takes a control under the sticky bar for one in view, so a keyboard walk down the
  // column went on behind the bar.
  it('scrolls a control focused under its bar clear of it, and leaves the rest where they are', () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [top, height] = this.hasAttribute('data-creator-bar') ? [700, 80] : this.textContent === 'Low' ? [680, 48] : [200, 48];
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    render(
      <CreatorColumnLayout
        title="Image creator"
        column={
          <>
            <button type="button">High</button>
            <button type="button">Low</button>
            <CreatorColumnBar settingsSummary="1K" settings={null} action={<button type="button">Generate</button>} />
          </>
        }
        canvas={<section aria-label="Result" />}
      />
    );

    fireEvent.focus(screen.getByRole('button', { name: 'High' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Generate' }));
    expect(scrollBy).not.toHaveBeenCalled();

    // Its bottom, 728, is 28px under the bar's top: that and 16px more.
    fireEvent.focus(screen.getByRole('button', { name: 'Low' }));
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 44 });
  });
});

describe('the setting choices', () => {
  function Ratios({ onChange }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState('auto');
    return (
      <CreatorSettingChoices
        label="Aspect ratio"
        options={['auto', '1:1', '16:9']}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        columns={5}
      />
    );
  }

  it('is a radio group whose chosen option says so, with one stop in the tab order', () => {
    render(<Ratios />);
    const group = screen.getByRole('radiogroup', { name: 'Aspect ratio' });
    const [auto, square, wide] = within(group).getAllByRole('radio');

    expect(auto).toHaveAttribute('aria-checked', 'true');
    expect(square).toHaveAttribute('aria-checked', 'false');
    expect([auto, square, wide].map((option) => option.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.click(wide);
    expect(wide).toHaveAttribute('aria-checked', 'true');
    expect(auto).toHaveAttribute('aria-checked', 'false');
  });

  it('moves the choice and the focus with the arrow keys, round the ends', () => {
    const onChange = vi.fn();
    render(<Ratios onChange={onChange} />);
    const auto = screen.getByRole('radio', { name: 'auto' });
    auto.focus();

    fireEvent.keyDown(auto, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('1:1');
    expect(screen.getByRole('radio', { name: '1:1' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('radio', { name: '1:1' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('16:9');

    fireEvent.keyDown(screen.getByRole('radio', { name: '16:9' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('auto');
    expect(screen.getByRole('radio', { name: 'auto' })).toHaveFocus();
  });
});

describe('the setting choices, named for their options', () => {
  it('reads an option by its label, and keeps a group the options name out of sight', () => {
    const onChange = vi.fn();
    render(
      <CreatorSettingChoices
        label="Shot mode"
        labelHidden
        options={['single', 'multi'] as const}
        optionLabel={(value) => (value === 'multi' ? 'Multi-shot' : 'Single shot')}
        value="single"
        onChange={onChange}
        columns={2}
        accent="video"
      />
    );

    const group = screen.getByRole('radiogroup', { name: 'Shot mode' });
    expect(screen.getByText('Shot mode')).toHaveClass('sr-only');
    expect(within(group).getByRole('radio', { name: 'Single shot' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(group).getByRole('radio', { name: 'Multi-shot' }));
    expect(onChange).toHaveBeenCalledWith('multi');
  });
});

describe('the setting switch', () => {
  it('is a switch that says whether it is on, and turns it at a press', () => {
    const onChange = vi.fn();
    const view = render(
      <CreatorSettingSwitch label="Fixed lens" description="Keeps the camera still." checked={false} onChange={onChange} accent="video" />
    );
    const toggle = screen.getByRole('switch', { name: /^Fixed lens/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);

    view.rerender(<CreatorSettingSwitch label="Fixed lens" checked onChange={onChange} accent="video" />);
    expect(screen.getByRole('switch', { name: 'Fixed lens' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the result clip\'s box', () => {
  function boxRatio() {
    return Number(screen.getByTestId('creator-canvas-media').style.getPropertyValue('--creator-frame-ratio'));
  }

  it('takes the shape asked for, 16:9 for "auto", and the clip\'s own once it is known', () => {
    const view = render(
      <CreatorCanvasMedia aspectRatio="9:16">
        <video data-testid="clip" />
      </CreatorCanvasMedia>
    );
    expect(boxRatio()).toBeCloseTo(9 / 16);

    view.rerender(
      <CreatorCanvasMedia aspectRatio="auto">
        <video data-testid="clip" />
      </CreatorCanvasMedia>
    );
    expect(boxRatio()).toBeCloseTo(16 / 9);

    // A portrait motion clip, which the page could not know the shape of before it loaded.
    const clip = screen.getByTestId('clip');
    Object.defineProperty(clip, 'videoWidth', { configurable: true, value: 720 });
    Object.defineProperty(clip, 'videoHeight', { configurable: true, value: 1280 });
    fireEvent(clip, new Event('loadedmetadata'));
    expect(boxRatio()).toBeCloseTo(720 / 1280);
  });
});

describe('the creator tool tabs', () => {
  it('names the creator open as the current page, underlines it in its accent and links the other two', () => {
    render(<CreatorToolTabs currentToolId="image" />);
    const tabs = screen.getByRole('navigation', { name: 'Creator tools' });
    const image = screen.getByRole('link', { name: 'Image' });

    expect(image).toHaveAttribute('aria-current', 'page');
    expect(image.querySelector('span[aria-hidden]')).toHaveClass('bg-brand-blue');
    expect(screen.getByRole('link', { name: 'Video' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Motion' })).not.toHaveAttribute('aria-current');
    // The video creator is heavy: it is fetched when opened, not ahead of time.
    expect(screen.getByRole('link', { name: 'Video' })).toHaveAttribute('data-prefetch', 'false');
    expect(tabs.querySelectorAll('a')).toHaveLength(3);
  });
});

describe('the column tiles', () => {
  it('opens the templates without fetching their page ahead of time', () => {
    render(<CreatorTemplatesTile />);
    const tile = screen.getByRole('link', { name: 'Templates' });
    expect(tile).toHaveAttribute('href', '/templates');
    expect(tile).toHaveAttribute('data-prefetch', 'false');
  });

  it('shows the balance on a phone, linked to pricing', () => {
    const view = render(<CreatorPhoneBalance credits={12} />);
    const balance = screen.getByRole('link', { name: '12 credits' });
    expect(balance).toHaveAttribute('href', '/pricing');
    expect(balance).toHaveClass('sm:hidden');

    view.rerender(<CreatorPhoneBalance credits={null} />);
    expect(screen.getByRole('link', { name: 'Credits' })).toBeInTheDocument();
  });
});

describe('the result canvas', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  function placeCanvas(top: number) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const y = this.getAttribute('aria-label') === 'Result' ? top : 0;
      return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON: () => ({}) } as DOMRect;
    });
  }

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    vi.restoreAllMocks();
  });

  it('comes into view when its reveal key moves while it is out of view, and not on mount', () => {
    placeCanvas(1500);
    const view = render(<CreatorCanvas title="Result" revealKey={0}>Empty</CreatorCanvas>);
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(<CreatorCanvas title="Result" revealKey={1}>Empty</CreatorCanvas>);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute('aria-label', 'Result');
  });

  it('stays put when its reveal key moves while it is in view', () => {
    placeCanvas(88);
    const view = render(<CreatorCanvas title="Result" revealKey={0}>Empty</CreatorCanvas>);

    view.rerender(<CreatorCanvas title="Result" revealKey={1}>Empty</CreatorCanvas>);

    expect(scrollIntoView).not.toHaveBeenCalled();
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

  function frameRatio() {
    return Number(screen.getByTestId('creator-canvas-frame').style.getPropertyValue('--creator-frame-ratio'));
  }

  it('takes the shape of the run, and a square for "auto"', () => {
    const view = render(<CreatorCanvasFrame aspectRatio="16:9">Empty</CreatorCanvasFrame>);
    expect(frameRatio()).toBeCloseTo(16 / 9);

    view.rerender(<CreatorCanvasFrame aspectRatio="auto">Empty</CreatorCanvasFrame>);
    expect(frameRatio()).toBe(1);
  });

  // At 8:1 the exact shape was a 40px strip on a phone, which cut the frame's own words.
  it.each([
    ['8:1', CANVAS_FRAME_RATIO_LIMITS.max],
    ['4:1', CANVAS_FRAME_RATIO_LIMITS.max],
    ['1:4', CANVAS_FRAME_RATIO_LIMITS.min],
    ['1:8', CANVAS_FRAME_RATIO_LIMITS.min],
  ])('draws %s no thinner than its limit', (aspectRatio, ratio) => {
    render(<CreatorCanvasFrame aspectRatio={aspectRatio}>Empty</CreatorCanvasFrame>);
    expect(frameRatio()).toBeCloseTo(ratio);
  });
});
