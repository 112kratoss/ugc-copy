import type { ComponentPropsWithoutRef } from 'react';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Image as ImageIcon, Plus } from 'lucide-react';

import { onCreditTopUpOpen } from '@/lib/credit-top-up';

import {
  CANVAS_FRAME_RATIO_LIMITS,
  CreatorAddTile,
  CreatorBarAction,
  CreatorCanvas,
  CreatorCanvasFrame,
  CreatorCanvasMedia,
  CreatorColumnBar,
  CreatorColumnLayout,
  CreatorMentionPanel,
  CreatorReferenceStrip,
  CreatorReferenceTile,
  CreatorSettingChoices,
  CreatorSettingSwitch,
  CreatorTemplatesTile,
  CreatorToolTabs,
  CreatorTopUpNotice,
  CreatorUploadSlot,
  CreatorRunFailed,
  CreatorRunFailedLine,
  CreatorRunWaitLines,
  CreatorMediaReferenceTile,
  CreatorReferenceRow,
  aspectRatioMark,
  columnWidthBounds,
  creatorRunChip,
  describeRunFailure,
  parseAspectRatio,
  type CreatorReferenceKind,
} from '@/components/CreatorColumn';

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: ({ className }: { className?: string }) => <button type="button" className={className}>Share</button>,
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

  // The creators hide the shell's bottom navigation below 768px (`hidesBottomNav`), where the bar
  // holds the window's bottom edge, the safe area inside it; wider it floats 0.75rem above the
  // edge. In px, as the shell's own breakpoint: `max-md` is 48rem, which moves with the browser's
  // text size (at 20px the bar sat flush up to 960px, where the shell floats it).
  it('holds the bottom edge on a phone, the safe area inside it, and floats just above it wider', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[data-creator-bar]');
    const classes = bar?.className.split(' ') ?? [];
    expect(classes).toEqual(expect.arrayContaining(['sticky', 'bottom-3', 'max-[768px]:bottom-0']));
    expect(bar?.firstElementChild?.className.split(' ')).toContain('max-[768px]:pb-[env(safe-area-inset-bottom)]');
    expect(bar?.className).not.toMatch(/max-md:/);
  });

  // `max-[1119px]` is `width < 1119px`: at 1119px, one column, the bar stayed stuck and the Publish
  // bar never showed. `max-[1120px]` is the exact complement of the two panes' `min-[1120px]`.
  it('waits at the column\'s end under the two panes\' width, with no safe area', () => {
    const { container } = render(
      <CreatorColumnBar
        settingsSummary="1K · AUTO · JPG"
        settings={null}
        holdsFootUnderColumn={false}
        action={<button type="button">Generate · 8 credits</button>}
      />
    );
    const bar = container.querySelector('[data-creator-bar]');
    expect(bar?.className.split(' ')).toContain('max-[1120px]:static');
    expect(bar?.firstElementChild?.className).not.toContain('safe-area-inset-bottom');
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

    // Whether the browser draws the focus (`:focus-visible`): the keyboard's, and not a press's.
    let fromKeyboard = true;
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? fromKeyboard : matches.call(this, selector);
    });

    act(() => screen.getByRole('button', { name: 'High' }).focus());
    act(() => screen.getByRole('button', { name: 'Generate' }).focus());
    expect(scrollBy).not.toHaveBeenCalled();

    // Its bottom, 728, is 28px under the bar's top: that and 16px more.
    act(() => screen.getByRole('button', { name: 'Low' }).focus());
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 44 });

    // A press focuses its control on the way down: scrolling then would move it from under
    // the pointer before the press ended, and the click would land on nothing.
    fromKeyboard = false;
    act(() => screen.getByRole('button', { name: 'High' }).focus());
    act(() => screen.getByRole('button', { name: 'Low' }).focus());
    expect(scrollBy).toHaveBeenCalledTimes(1);
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

  it('draws each ratio as a box to scale beside its words where the page asks for it', () => {
    const ratios = ['auto', '1:1', '9:16', '21:9', '1:8'];
    const view = render(
      <CreatorSettingChoices
        label="Aspect ratio"
        options={ratios}
        value="9:16"
        onChange={() => {}}
        columns={5}
        optionMark={aspectRatioMark}
      />
    );
    const boxOf = (name: string) => within(screen.getByRole('radio', { name })).queryByTestId('creator-option-ratio-box');

    expect(boxOf('auto')).toBeNull();
    expect(boxOf('1:1')).toHaveStyle({ width: '14px', height: '14px' });
    expect(boxOf('9:16')).toHaveStyle({ width: '8px', height: '14px' });
    expect(boxOf('21:9')).toHaveStyle({ width: '14px', height: '6px' });
    // To scale, 1:8 would be 2px wide: it keeps 3px, so it still shows as a bar.
    expect(boxOf('1:8')).toHaveStyle({ width: '3px', height: '14px' });
    // A picture of the words, so the option is still read by its ratio alone.
    expect(boxOf('9:16')).toHaveAttribute('aria-hidden', 'true');
    // The chosen one's box takes the accent, as its border does.
    expect(boxOf('9:16')?.parentElement).toHaveClass('text-brand-blue');
    expect(boxOf('1:1')?.parentElement).not.toHaveClass('text-brand-blue');

    // The group draws no box of its own accord, even for options written as ratios.
    view.rerender(<CreatorSettingChoices label="Aspect ratio" options={ratios} value="9:16" onChange={() => {}} columns={5} />);
    expect(screen.queryAllByTestId('creator-option-ratio-box')).toHaveLength(0);
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

  it('takes the shape asked for, square for "auto" as its frame was, and the clip\'s own once it is known', () => {
    const view = render(
      <CreatorCanvasMedia aspectRatio="9:16">
        <video data-testid="clip" />
      </CreatorCanvasMedia>
    );
    expect(boxRatio()).toBeCloseTo(9 / 16);

    // "auto" draws the same square the running frame drew, so the box changes shape
    // once, to the clip's, and not square → 16:9 → the clip's.
    view.rerender(
      <CreatorCanvasMedia aspectRatio="auto">
        <video data-testid="clip" />
      </CreatorCanvasMedia>
    );
    expect(boxRatio()).toBe(1);
    view.rerender(
      <CreatorCanvasMedia aspectRatio={undefined}>
        <video data-testid="clip" />
      </CreatorCanvasMedia>
    );
    expect(boxRatio()).toBe(1);

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

  // The build notes (owner-approved mock-up): focus moves to "Done" when a run ends.
  it('gives its heading the focus when a run ends, and not on mount', () => {
    const page = (title: string, focusKey: number) => (
      <><div data-creator-bar><button type="button">Generate</button></div><CreatorCanvas title={title} focusKey={focusKey}>Busy</CreatorCanvas></>
    );
    const view = render(page('Making your video', 0));
    screen.getByRole('button', { name: 'Generate' }).focus();
    expect(screen.getByRole('button', { name: 'Generate' })).toHaveFocus();

    view.rerender(page('Done', 1));

    expect(screen.getByRole('heading', { name: 'Done' })).toHaveFocus();
  });

  it('takes the focus from the page itself and from the canvas, where a run is tried again', () => {
    const view = render(<CreatorCanvas title="Making your video" focusKey={0}><button type="button">Try again</button></CreatorCanvas>);
    expect(document.body).toHaveFocus();
    view.rerender(<CreatorCanvas title="It didn’t finish" focusKey={1}><button type="button">Try again</button></CreatorCanvas>);
    expect(screen.getByRole('heading', { name: 'It didn’t finish' })).toHaveFocus();

    screen.getByRole('button', { name: 'Try again' }).focus();
    view.rerender(<CreatorCanvas title="Done" focusKey={2}><button type="button">Try again</button></CreatorCanvas>);
    expect(screen.getByRole('heading', { name: 'Done' })).toHaveFocus();
  });

  it('leaves the focus with a creator at work in the column, a model picked or a row pressed', () => {
    const page = (title: string, focusKey: number) => (
      <><div role="listbox" aria-label="Video models"><button type="button">Seedance 2 Mini</button></div><CreatorCanvas title={title} focusKey={focusKey}>Busy</CreatorCanvas></>
    );
    const view = render(page('Making your video', 0));
    screen.getByRole('button', { name: 'Seedance 2 Mini' }).focus();

    view.rerender(page('Done', 1));

    expect(screen.getByRole('button', { name: 'Seedance 2 Mini' })).toHaveFocus();
  });

  it('leaves the focus where it is while a preview holds the page', () => {
    const page = (title: string, focusKey: number) => (
      <>
        <div data-creator-bar><button type="button">Generate</button></div>
        <div role="dialog" aria-modal="true" aria-label="Preview" />
        <CreatorCanvas title={title} focusKey={focusKey}>Busy</CreatorCanvas>
      </>
    );
    const view = render(page('Making your video', 0));
    screen.getByRole('button', { name: 'Generate' }).focus();

    view.rerender(page('Done', 1));

    expect(screen.getByRole('button', { name: 'Generate' })).toHaveFocus();
  });

  it('leaves the focus with a creator typing the next prompt when a run ends', () => {
    const view = render(<><textarea aria-label="Prompt" /><CreatorCanvas title="Making your video" focusKey={0}>Busy</CreatorCanvas></>);
    screen.getByRole('textbox', { name: 'Prompt' }).focus();

    view.rerender(<><textarea aria-label="Prompt" /><CreatorCanvas title="Done" focusKey={1}>Clip</CreatorCanvas></>);

    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus();
  });

  it('leaves the focus in a dialog the creator opened while the run worked', () => {
    const view = render(<><div role="dialog" aria-label="Generation settings"><button type="button">720p</button></div><CreatorCanvas title="Making your video" focusKey={0}>Busy</CreatorCanvas></>);
    screen.getByRole('button', { name: '720p' }).focus();

    view.rerender(<><div role="dialog" aria-label="Generation settings"><button type="button">720p</button></div><CreatorCanvas title="Done" focusKey={1}>Clip</CreatorCanvas></>);

    expect(screen.getByRole('button', { name: '720p' })).toHaveFocus();
  });

  // Under the column on a phone the canvas can be out of view when the run ends: the browser
  // brings a focused element into view, so the focus keeps that scroll, and adds none of its own.
  it('lets the focus bring the heading into view where it is out of it', () => {
    placeCanvas(1500);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const view = render(<CreatorCanvas title="Making your video" focusKey={0}>Busy</CreatorCanvas>);

    view.rerender(<CreatorCanvas title="Done" focusKey={1}>Clip</CreatorCanvas>);

    expect(screen.getByRole('heading', { name: 'Done' })).toHaveFocus();
    expect(focus.mock.calls.at(-1)?.[0]).toBeUndefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('says what the run is and holds beside its title', () => {
    render(<CreatorCanvas title="Done" chip="Seedance 2 Mini · 480P · 9:16 · 5s · 19 credits">Clip</CreatorCanvas>);
    expect(screen.getByTestId('creator-canvas-chip')).toHaveTextContent('Seedance 2 Mini · 480P · 9:16 · 5s · 19 credits');
  });
});

describe('the run\'s line and its failure', () => {
  it('names the run and what it holds, and no credits where it holds none', () => {
    expect(creatorRunChip('Seedance 2 Mini · 480P · 9:16 · 5s · Sound off', 19)).toBe('Seedance 2 Mini · 480P · 9:16 · 5s · Sound off · 19 credits');
    expect(creatorRunChip('Seedance 2 Mini · 480P · 5s', 1)).toBe('Seedance 2 Mini · 480P · 5s · 1 credit');
    expect(creatorRunChip('Seedance 2 Mini · 480P · 5s', null)).toBe('Seedance 2 Mini · 480P · 5s');
    expect(creatorRunChip(null, 19)).toBe('19 credits');
    expect(creatorRunChip(null, null)).toBeNull();
  });

  it('names the reason a run failed, or that the model\'s service stopped where it gave none', () => {
    expect(describeRunFailure('This model would not accept the reference image because it looks like a photo of a real person.', 'video'))
      .toBe('This model would not accept the reference image because it looks like a photo of a real person.');
    for (const generic of ['Unknown error', 'Video generation failed', 'Generation failed.', '', null]) {
      expect(describeRunFailure(generic, 'video')).toBe('The model’s service stopped before your video was done.');
    }
  });

  it('says its credits are back, and offers the run again or the prompt', () => {
    const onRetry = vi.fn();
    const onChangePrompt = vi.fn();
    render(
      <CreatorRunFailed
        cause="The model’s service stopped before your video was done."
        returnedCredits={19}
        retryLabel="Try again · 19 credits"
        retryDisabled={false}
        onRetry={onRetry}
        onChangePrompt={onChangePrompt}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The model’s service stopped before your video was done.Your 19 credits are back.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again · 19 credits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change the prompt' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onChangePrompt).toHaveBeenCalledTimes(1);
  });

  it('offers another model where the same run cannot get past its cause', () => {
    const onRetry = vi.fn();
    const onPickModel = vi.fn();
    render(
      <CreatorRunFailed
        cause="This model would not accept the reference image because it looks like a photo of a real person."
        returnedCredits={null}
        retryLabel="Try again · 19 credits"
        retryDisabled={false}
        onRetry={onRetry}
        retryable={false}
        onPickModel={onPickModel}
        onChangePrompt={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your credits are back.');
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick another model' }));
    expect(onPickModel).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // Under the column on a phone the canvas can be out of view: the bar says a run failed.
  it('says in the bar, under the column only, that a run failed and its credits are back', () => {
    const onSeeWhy = vi.fn();
    render(
      <CreatorColumnBar
        settingsSummary="480P · 5s"
        settings={null}
        narrowStatus={<CreatorRunFailedLine returnedCredits={19} onSeeWhy={onSeeWhy} />}
        action={<button type="button">Generate</button>}
      />,
    );
    const line = screen.getByText(/Your run didn’t finish\. Your 19 credits are back\./);
    expect(line.closest('[data-creator-bar-narrow-status]')).toHaveClass('min-[1120px]:hidden');
    fireEvent.click(screen.getByRole('button', { name: 'See why' }));
    expect(onSeeWhy).toHaveBeenCalledTimes(1);
  });

  it('promises the alert a finished run sends, and says what the run holds', () => {
    render(<CreatorRunWaitLines noun="video" heldCredits={19} />);
    expect(screen.getByText(/you’ll get an alert when it’s ready/)).toBeInTheDocument();
    expect(screen.getByText('19 credits are held for this run. If it fails, they come back.')).toBeInTheDocument();
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

  // A model the catalog has listed but not yet described has no ratios, so none is chosen.
  it.each<string | null | undefined>(['auto', '', '16x9', '0:1', '4:0', undefined, null])('reads %j as no ratio', (aspectRatio) => {
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

    view.rerender(<CreatorCanvasFrame aspectRatio={undefined}>Empty</CreatorCanvasFrame>);
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

/**
 * The pieces the three creators share (2026-10-26). Each page had its own copy of
 * them, and the copies had drifted: the video page's bar put Top Up in Generate's
 * place mid-run, and the rows' Insert and Copy were not named for their handle.
 */
describe('the bar\'s action', () => {
  const ready = {
    awaitingCheck: false,
    onCheckAgain: () => {},
    showTopUp: false,
    isGenerating: false,
    disabled: false,
    costLabel: '12 credits',
    hasPrice: true,
    onGenerate: () => {},
  };

  it('is Generate named with its price, which says why it waits until there is one', () => {
    const onGenerate = vi.fn();
    const view = render(<CreatorBarAction {...ready} onGenerate={onGenerate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate · 12 credits' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);

    view.rerender(<CreatorBarAction {...ready} hasPrice={false} costLabel="Calculating..." disabled />);
    const waiting = screen.getByRole('button', { name: 'Generate · Calculating...' });
    expect(waiting).toHaveTextContent(/^Calculating\.\.\.$/);
    expect(waiting).toBeDisabled();
  });

  it('checks an unanswered start again before it offers anything else', () => {
    const onCheckAgain = vi.fn();
    render(<CreatorBarAction {...ready} awaitingCheck showTopUp onCheckAgain={onCheckAgain} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Top Up Credits' })).toBeNull();
  });

  it('offers a top-up for a short balance, which opens the packs on the page, but never in place of a run under way', () => {
    const opened: unknown[] = [];
    const stop = onCreditTopUpOpen((request) => opened.push(request));
    const view = render(<CreatorBarAction {...ready} showTopUp topUpNeed={{ cost: 140, balance: 10 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Top Up Credits' }));
    expect(opened).toEqual([{ need: { cost: 140, balance: 10 }, pricingHref: '/pricing' }]);
    stop();

    // The run spent the balance below the next run's price; the place is still the run's.
    view.rerender(<CreatorBarAction {...ready} showTopUp isGenerating />);
    expect(screen.queryByRole('button', { name: 'Top Up Credits' })).toBeNull();
    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
  });

  // A remix keeps no draft, so the pricing page its packs offer is told the way back to it.
  it('tells the packs the pricing page the page says', () => {
    const toRemix = `/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`;
    const opened: unknown[] = [];
    const stop = onCreditTopUpOpen((request) => opened.push(request));
    render(<CreatorBarAction {...ready} showTopUp topUpHref={toRemix} />);
    fireEvent.click(screen.getByRole('button', { name: 'Top Up Credits' }));
    stop();
    expect(opened).toEqual([{ need: null, pricingHref: toRemix }]);
  });
});

describe('the top-up notice', () => {
  it('sets the run\'s price against the balance, or gives the server\'s refusal', () => {
    const view = render(<CreatorTopUpNotice cost={24} balance={10} message={null} />);
    expect(screen.getByText(/This run costs/)).toHaveTextContent('This run costs 24 credits but you only have 10.');

    view.rerender(<CreatorTopUpNotice cost={24} balance={40} message="Your balance changed since the price was read." />);
    expect(screen.getByText('Your balance changed since the price was read.')).toBeInTheDocument();
    expect(screen.queryByText(/This run costs/)).toBeNull();
  });
});

// A mouse drags a strip sideways, as a finger swipes it (owner, 2026-11-02).
describe('a reference strip under a mouse', () => {
  function strip(onPress = vi.fn()) {
    render(
      <CreatorReferenceStrip aria-label="Reference images">
        {['Hero', 'Villain', 'Sidekick', 'Mentor'].map((name) => (
          <li key={name}>
            <button type="button" onClick={onPress}>Preview {name}</button>
            <input aria-label={`Name of ${name}`} defaultValue={name} />
            <audio aria-label={`Track of ${name}`} controls />
          </li>
        ))}
      </CreatorReferenceStrip>
    );
    const list = screen.getByRole('list', { name: 'Reference images' });
    // jsdom lays nothing out: the strip is given a row twice as wide as it shows.
    let left = 0;
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(list, 'scrollLeft', { configurable: true, get: () => left, set: (value: number) => { left = value; } });
    return { list, scrolled: () => left, onPress };
  }
  // The primary button held, as it is through a drag (`buttons` says which buttons are down).
  const mouse = (clientX: number, buttons = 1) => ({ pointerType: 'mouse', button: 0, buttons, pointerId: 1, clientX });

  it('scrolls under a drag that moves past 6px, and the click that ends the drag presses nothing', () => {
    const { list, scrolled, onPress } = strip();
    const preview = screen.getByRole('button', { name: 'Preview Villain' });

    fireEvent.pointerDown(preview, mouse(300));
    fireEvent.pointerMove(preview, mouse(296));
    expect(scrolled()).toBe(0);
    fireEvent.pointerMove(preview, mouse(180));
    expect(scrolled()).toBe(120);
    // Snapping would pull the row back at every step.
    expect(list.style.getPropertyValue('scroll-snap-type')).toBe('none');
    fireEvent.pointerUp(preview, mouse(180));
    fireEvent.click(preview);

    expect(onPress).not.toHaveBeenCalled();
    expect(list.style.getPropertyValue('scroll-snap-type')).toBe('');

    // A press that does not move is a press.
    fireEvent.pointerDown(preview, mouse(180));
    fireEvent.pointerUp(preview, mouse(180));
    fireEvent.click(preview);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('leaves a finger, and a press in a field, to the browser', () => {
    const { scrolled } = strip();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Preview Hero' }), { ...mouse(300), pointerType: 'touch' });
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Preview Hero' }), { ...mouse(150), pointerType: 'touch' });
    expect(scrolled()).toBe(0);

    const name = screen.getByRole('textbox', { name: 'Name of Hero' });
    fireEvent.pointerDown(name, mouse(300));
    fireEvent.pointerMove(name, mouse(150));
    expect(scrolled()).toBe(0);
  });

  // A track's seek bar lives in the player's own shadow tree, so its press reaches the row as the player's.
  it("leaves a player's own controls to it", () => {
    const { scrolled } = strip();
    const track = screen.getByLabelText('Track of Villain');
    fireEvent.pointerDown(track, mouse(300));
    fireEvent.pointerMove(track, mouse(150));
    expect(scrolled()).toBe(0);
  });

  // A press let go outside the row before it moved: the row heard no release, and the mouse
  // passing over it afterwards, no button held, is no drag.
  it('drops a press let go outside the row before it moved', () => {
    const { list, scrolled, onPress } = strip();
    const preview = screen.getByRole('button', { name: 'Preview Villain' });
    fireEvent.pointerDown(preview, mouse(300));
    fireEvent.pointerMove(preview, mouse(298));
    fireEvent.pointerMove(preview, mouse(150, 0));
    fireEvent.pointerMove(preview, mouse(100, 0));
    expect(scrolled()).toBe(0);
    expect(list.style.getPropertyValue('cursor')).toBe('');

    fireEvent.click(preview);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('a reference tile', () => {
  it('lays its references side by side in one row that scrolls sideways', () => {
    render(
      <CreatorReferenceStrip aria-label="Reference images">
        {['Hero', 'Villain', 'Sidekick'].map((name) => (
          <CreatorReferenceTile
            key={name}
            accent="image"
            preview={<span />}
            displayName={name}
            nameDraft={undefined}
            placeholder="Rename element"
            onNameChange={() => {}}
            onNameCommit={() => {}}
            onNameCancel={() => {}}
            onRemove={() => {}}
            handle={`@${name.toLowerCase()}`}
            handleClassName="text-sky-300"
            onInsert={() => {}}
          />
        ))}
      </CreatorReferenceStrip>
    );
    const strip = screen.getByRole('list', { name: 'Reference images' });

    expect(within(strip).getAllByRole('listitem')).toHaveLength(3);
    // One column of tiles that runs sideways, never a second line of them.
    expect(strip).toHaveClass('grid-flow-col', 'overflow-x-auto');
  });

  it('brings a reference added to the strip into view, and leaves the first ones where they start', () => {
    const scrollTo = vi.fn();
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const strip = (names: string[]) => (
      <CreatorReferenceStrip aria-label="Reference images">
        {names.map((name) => (
          <CreatorReferenceTile
            key={name}
            accent="image"
            preview={<span />}
            displayName={name}
            nameDraft={undefined}
            placeholder="Rename element"
            onNameChange={() => {}}
            onNameCommit={() => {}}
            onNameCancel={() => {}}
            onRemove={() => {}}
            handle={`@${name.toLowerCase()}`}
            handleClassName="text-sky-300"
            onInsert={() => {}}
          />
        ))}
      </CreatorReferenceStrip>
    );
    try {
      // A remix's restored set, or the first pictures picked, start at the strip's left.
      const view = render(strip(['Hero', 'Villain']));
      expect(scrollTo).not.toHaveBeenCalled();

      view.rerender(strip(['Hero', 'Villain', 'Sidekick']));
      expect(scrollTo).toHaveBeenCalledTimes(1);

      // A removal moves nothing.
      view.rerender(strip(['Hero', 'Sidekick']));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      if (own) Object.defineProperty(HTMLElement.prototype, 'scrollTo', own);
      else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it('names its controls for the reference and the handle they act on', () => {
    const calls = {
      onNameChange: vi.fn(),
      onNameCommit: vi.fn(),
      onNameCancel: vi.fn(),
      onRemove: vi.fn(),
      onInsert: vi.fn(),
      onCopy: vi.fn(),
    };
    render(
      <ul>
        <CreatorReferenceTile
          accent="video"
          preview={<span />}
          displayName="Hero"
          nameDraft={undefined}
          placeholder="Rename element"
          handle="@hero"
          handleClassName="text-sky-300"
          note="4s clip"
          {...calls}
        />
      </ul>
    );

    // The handle is the one Insert control: a tile has no room for a second.
    expect(screen.getAllByRole('button', { name: /^Insert/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Insert @hero' })).toHaveTextContent('@hero');
    fireEvent.click(screen.getByRole('button', { name: 'Insert @hero' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy @hero' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hero' }));
    expect(calls.onInsert).toHaveBeenCalledTimes(1);
    expect(calls.onCopy).toHaveBeenCalledTimes(1);
    expect(calls.onRemove).toHaveBeenCalledTimes(1);
    expect(screen.getByText('4s clip')).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: 'Name of Hero' });
    fireEvent.change(name, { target: { value: 'Villain' } });
    expect(calls.onNameChange).toHaveBeenCalledWith('Villain');
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(calls.onNameCommit).toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(calls.onNameCancel).toHaveBeenCalledTimes(1);
  });

  it('offers Copy only where the page gives one', () => {
    render(
      <ul>
        <CreatorReferenceTile
          accent="image"
          preview={<span />}
          displayName="Hero"
          nameDraft="Her"
          placeholder="Rename element"
          onNameChange={() => {}}
          onNameCommit={() => {}}
          onNameCancel={() => {}}
          onRemove={() => {}}
          handle="@hero"
          handleClassName="text-sky-300"
          onInsert={() => {}}
        />
      </ul>
    );
    expect(screen.queryByRole('button', { name: /^Copy/ })).toBeNull();
    // The name being typed shows over the saved one.
    expect(screen.getByRole('textbox', { name: 'Name of Hero' })).toHaveValue('Her');
  });
});

describe('the mention panel', () => {
  it('is a group named for its title, offering each match by name and handle', () => {
    const onInsert = vi.fn();
    render(
      <CreatorMentionPanel
        title="Insert element"
        hint="Pick an element to insert its @mention."
        query="he"
        suggestions={[{ id: 'hero', displayName: 'Hero', handle: '@hero' }]}
        handleClassName={() => 'text-sky-300'}
        onInsert={onInsert}
      />
    );
    const group = screen.getByRole('group', { name: 'Insert element' });
    expect(within(group).getByText('@he')).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: /^Hero\s*@hero$/ }));
    expect(onInsert).toHaveBeenCalledWith('@hero');
  });
});

describe('the add tile', () => {
  it('is a label around its file field, which a locked page can switch off', () => {
    const onChange = vi.fn();
    const view = render(
      <CreatorAddTile accent="video" icon={Plus} label="Add images" input={{ accept: 'image/*', multiple: true, onChange }} dragging={false} />
    );
    const field = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(field.closest('label')).toHaveTextContent('Add images');
    expect(field).toHaveClass('sr-only');
    fireEvent.change(field, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } });
    expect(onChange).toHaveBeenCalledTimes(1);

    view.rerender(
      <CreatorAddTile accent="video" icon={Plus} label="Add images" input={{ accept: 'image/*', disabled: true, onChange }} dragging={false} />
    );
    expect(view.container.querySelector('input[type="file"]')).toBeDisabled();
  });
});

describe('an upload slot', () => {
  function slot(props: { src: string | null; disabled?: boolean }) {
    return (
      <CreatorUploadSlot
        accent="motion"
        title="Character image"
        status="required"
        height="tall"
        mediaType="image"
        src={props.src}
        alt="Character"
        previewHint="Preview image"
        icon={ImageIcon}
        emptyLabel="Upload image"
        input={{ id: 'character-input', accept: 'image/*', disabled: props.disabled, onChange: () => {} }}
        onPreview={() => {}}
        onRemove={() => {}}
        dragging={false}
      />
    );
  }

  it('has one file field: the empty tile is its label, and Replace on a filled slot opens it', () => {
    const view = render(slot({ src: null }));
    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getByText('Upload image').closest('label')).toHaveAttribute('for', 'character-input');

    view.rerender(slot({ src: 'blob:character' }));
    expect(view.container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    const field = view.container.querySelector<HTMLInputElement>('#character-input')!;
    const opened = vi.spyOn(field, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Replace Character' }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('keeps a locked slot out of reach of the keyboard', () => {
    const view = render(slot({ src: null, disabled: true }));
    expect(view.container.querySelector('#character-input')).toBeDisabled();
  });
});

// A row for each kind of reference a model takes, each led by its add box, after the app's box (2026-11-01).
describe('the references rows', () => {
  const kind = (name: string, railLabel: string, accept: string, count = 0, limit = 3): CreatorReferenceKind => ({
    railLabel,
    hint: `${name} hint`,
    accept,
    count,
    limit,
    onFiles: vi.fn(),
  });
  const image = (count = 0) => kind('Image', 'Images', 'image/*', count, 5);
  const video = (count = 0) => kind('Video', 'Video', 'video/*', count);
  const audio = (count = 0) => kind('Audio', 'Audio', 'audio/*', count);
  const rows = (kinds: CreatorReferenceKind[]) => (
    <>
      {kinds.map((each) => <CreatorReferenceRow key={each.railLabel} accent="video" kind={each} stripLabel={`Reference ${each.railLabel}`} />)}
    </>
  );

  it('gives each kind a box of its own, with its count and what it is for', () => {
    render(rows([image(2), video(), audio(1)]));
    const boxes = screen.getAllByRole('button');

    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual(['Add images, 2 of 5', 'Add video, 0 of 3', 'Add audio, 1 of 3']);
    expect(boxes[0]).toHaveTextContent('Images');
    expect(boxes[0]).toHaveTextContent('2/5');
    expect(boxes[1]).toHaveAccessibleDescription('Video hint');
  });

  it('says what an empty kind is for beside its box, and shows its references there once it has some', () => {
    render(
      <>
        <CreatorReferenceRow accent="video" kind={video()} stripLabel="Reference videos">{[]}</CreatorReferenceRow>
        <CreatorReferenceRow accent="video" kind={audio()} stripLabel="Reference audio" />
        <CreatorReferenceRow accent="video" kind={kind('Voice', 'Voices', 'audio/*')} stripLabel="Voices">{false}</CreatorReferenceRow>
        <CreatorReferenceRow accent="video" kind={image(1)} stripLabel="Reference images">
          {['Hero'].map((name) => <li key={name}>{name}</li>)}
        </CreatorReferenceRow>
      </>
    );

    // A kind with no tiles, given none, an empty list of them, or a `false` left by a condition.
    expect(screen.getByText('Video hint', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Audio hint', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('Voice hint', { selector: 'p' })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Voices' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Reference videos' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Reference images' })).getByText('Hero')).toBeInTheDocument();
    expect(screen.queryByText('Image hint', { selector: 'p' })).toBeNull();
  });

  it('opens the picker of the box pressed, and no other', () => {
    render(rows([image(), video()]));
    const clipPicker = vi.spyOn(screen.getByLabelText('Add video'), 'click');
    const picturePicker = vi.spyOn(screen.getByLabelText('Add images'), 'click');

    fireEvent.click(screen.getByRole('button', { name: 'Add video, 0 of 3' }));

    expect(clipPicker).toHaveBeenCalledTimes(1);
    expect(picturePicker).not.toHaveBeenCalled();
  });

  it('hands picked files to their kind', () => {
    const kinds = [image(), video()];
    render(rows(kinds));
    const clip = new File(['clip'], 'walk.mp4', { type: 'video/mp4' });

    fireEvent.change(screen.getByLabelText('Add video'), { target: { files: [clip] } });

    expect(kinds[1].onFiles).toHaveBeenCalledWith([clip]);
    expect(kinds[0].onFiles).not.toHaveBeenCalled();
  });

  it('hands a drop on a box to its kind, whose check refuses a file of another kind', () => {
    const kinds = [image(), video()];
    render(rows(kinds));
    const clip = new File(['clip'], 'walk.mov', { type: 'video/quicktime' });
    const photo = new File(['photo'], 'face.png', { type: 'image/png' });

    fireEvent.drop(screen.getByRole('button', { name: 'Add video, 0 of 3' }), { dataTransfer: { files: [clip, photo] } });

    expect(kinds[1].onFiles).toHaveBeenCalledWith([clip, photo]);
    expect(kinds[0].onFiles).not.toHaveBeenCalled();
  });

  it('says a drop is welcome while a file is over a box', () => {
    render(rows([image()]));
    const box = screen.getByRole('button', { name: 'Add images, 0 of 5' });

    fireEvent.dragOver(box);
    expect(box).toHaveTextContent('Drop here');
    fireEvent.dragLeave(box);
    expect(box).toHaveTextContent('Images');
  });

  it('dims a full kind\'s box and leaves the others', () => {
    render(rows([image(5), video(), audio(3)]));

    expect(screen.getByRole('button', { name: 'Add images, 5 of 5' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add video, 0 of 3' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add audio, 3 of 3' })).toBeDisabled();
  });
});

describe('a clip or track tile', () => {
  it('puts Remove on a clip\'s frame, and says in red why the run holds it back', () => {
    const onRemove = vi.fn();
    render(
      <ul>
        <CreatorMediaReferenceTile
          preview={<button type="button" aria-label="Preview Walk" />}
          displayName="Walk"
          line="1.0s clip, under the 2s minimum"
          lineHeld
          onRemove={onRemove}
        />
      </ul>
    );

    expect(screen.getByRole('button', { name: 'Preview Walk' })).toBeInTheDocument();
    expect(screen.getByText('1.0s clip, under the 2s minimum')).toHaveClass('text-red-400');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Walk' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('puts Remove beside a track\'s name, its player under it, and Replace on one a remix brought back', () => {
    render(
      <ul>
        <CreatorMediaReferenceTile
          player={<audio aria-label="Audio preview" />}
          displayName="Voice"
          line="6.5s track"
          onRemove={() => {}}
          replace={{ label: 'Replace Voice with your own track', accept: 'audio/*', onFile: () => {} }}
        />
      </ul>
    );

    expect(screen.getByText('6.5s track')).not.toHaveClass('text-red-400');
    expect(screen.getByRole('button', { name: 'Remove Voice' })).toBeInTheDocument();
    expect(screen.getByLabelText('Audio preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace Voice with your own track' })).toBeInTheDocument();
  });
});

// The bar between the column and the result drags the column (owner, 2026-11-02). jsdom lays nothing
// out, so the drag itself is `tests/e2e/creator-column-resize.spec.ts`; here, its bounds, keys and memory.
describe('the column resizer', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  const layout = () => render(
    <CreatorColumnLayout title="Video creator" column={<div>Column</div>} canvas={<section aria-label="Result" />} />
  );

  it('reaches from the layout\'s floor to what leaves the result its 440px, and never past 720px', () => {
    expect(columnWidthBounds(1131)).toEqual({ min: 340, max: 671 });
    expect(columnWidthBounds(2000)).toEqual({ min: 340, max: 720 });
    expect(columnWidthBounds(600)).toEqual({ min: 340, max: 340 });
  });

  it('is a separator for the column, which the arrow keys move, kept until a double-click resets it', () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
    try {
      const { container } = layout();
      const grid = container.firstElementChild as HTMLElement;
      const grip = screen.getByRole('separator', { name: 'Column width' });
      expect(grip).toHaveAttribute('aria-controls', screen.getByText('Column').parentElement?.id);
      expect(grip).toHaveAttribute('aria-valuemin', '340');
      expect(grid).not.toHaveAttribute('data-resized');

      fireEvent.keyDown(grip, { key: 'ArrowRight' });
      expect(window.localStorage.getItem('creator-column-width')).toBe('356');
      expect(grid).toHaveAttribute('data-resized');
      expect(grid.style.getPropertyValue('--creator-column-width')).toBe('356px');

      fireEvent.keyDown(grip, { key: 'End' });
      expect(window.localStorage.getItem('creator-column-width')).toBe('720');

      fireEvent.doubleClick(grip);
      expect(window.localStorage.getItem('creator-column-width')).toBeNull();
      expect(grid).not.toHaveAttribute('data-resized');
      expect(grid.style.getPropertyValue('--creator-column-width')).toBe('');

      // Enter is the keyboard's way back to the layout's own width.
      fireEvent.keyDown(grip, { key: 'End' });
      expect(grid).toHaveAttribute('data-resized');
      fireEvent.keyDown(grip, { key: 'Enter' });
      expect(window.localStorage.getItem('creator-column-width')).toBeNull();
      expect(grid).not.toHaveAttribute('data-resized');
    } finally {
      // jsdom keeps clientWidth on Element.prototype: the stub above is HTMLElement's own, so it goes.
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it('draws the width kept in this browser', () => {
    window.localStorage.setItem('creator-column-width', '500');
    const grid = layout().container.firstElementChild as HTMLElement;

    expect(grid).toHaveAttribute('data-resized');
    expect(grid.style.getPropertyValue('--creator-column-width')).toBe('500px');
  });
});

// The layout's half of the one-column break: `max-[1120px]` (width < 1120px), the exact complement of
// the two panes' `min-[1120px]`; `max-[1119px]` left 1119px in one column with the result not first.
describe('the creator column layout', () => {
  it('moves the result first under the two panes\' width when asked', () => {
    const { container } = render(
      <CreatorColumnLayout title="Video creator" column={<div>Column</div>} canvas={<section aria-label="Result" />} resultFirst />
    );
    const grid = container.querySelector('h1')?.parentElement;
    expect(grid?.className.split(' ')).toContain('max-[1120px]:[&>section]:order-first');
    expect(grid?.className).not.toMatch(/1119/);
  });
});

