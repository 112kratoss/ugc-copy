import type { ComponentPropsWithoutRef } from 'react';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Image as ImageIcon, Plus } from 'lucide-react';

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
  CreatorReferenceRow,
  CreatorResultActions,
  CreatorSettingChoices,
  CreatorSettingSwitch,
  CreatorTemplatesTile,
  CreatorToolTabs,
  CreatorTopUpNotice,
  CreatorUploadSlot,
  parseAspectRatio,
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
    expect(screen.queryByRole('link', { name: 'Top Up Credits' })).toBeNull();
  });

  it('offers a top-up for a short balance, but never in place of a run under way', () => {
    const view = render(<CreatorBarAction {...ready} showTopUp />);
    expect(screen.getByRole('link', { name: 'Top Up Credits' })).toHaveAttribute('href', '/pricing');

    // The run spent the balance below the next run's price; the place is still the run's.
    view.rerender(<CreatorBarAction {...ready} showTopUp isGenerating />);
    expect(screen.queryByRole('link', { name: 'Top Up Credits' })).toBeNull();
    expect(screen.getByRole('button', { name: /Generating/ })).toBeDisabled();
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

describe('a reference row', () => {
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
        <CreatorReferenceRow
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
        <CreatorReferenceRow
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

describe('the result\'s actions', () => {
  const share = { title: 'Harbour', description: null, sourceSurface: 'create-video' as const, accessToken: null };

  it('publishes a private result, downloads it and puts it away', () => {
    const onPublish = vi.fn();
    const onStartAnother = vi.fn();
    const view = render(
      <CreatorResultActions
        generationId="gen-1"
        isPublic={false}
        share={share}
        publicPath={null}
        onPublish={onPublish}
        download={{ href: 'https://cdn.example/clip.mp4', fileName: 'generated-video.mp4', label: 'Download video', newTab: true }}
        onStartAnother={onStartAnother}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish & share' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    const download = screen.getByRole('link', { name: 'Download video' });
    expect(download).toHaveAttribute('download', 'generated-video.mp4');
    expect(download).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Start another run' }));
    expect(onStartAnother).toHaveBeenCalledTimes(1);

    view.rerender(
      <CreatorResultActions
        generationId="gen-1"
        isPublic={false}
        share={share}
        publicPath={null}
        onPublish={onPublish}
        preparingPublish
        download={{ href: 'blob:picture', fileName: 'generated-image.png', label: 'Download image' }}
        onStartAnother={onStartAnother}
      />
    );
    expect(screen.getByRole('button', { name: 'Publish & share' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Download image' })).not.toHaveAttribute('target');
  });

  it('shares a public result and links its page, and offers no publishing before the run is saved', () => {
    const view = render(
      <CreatorResultActions
        generationId="gen-1"
        isPublic
        share={share}
        publicPath="/p/harbour"
        onPublish={() => {}}
        download={{ href: 'blob:clip', fileName: 'clip.mp4', label: 'Download video' }}
        onStartAnother={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open public page' })).toHaveAttribute('href', '/p/harbour');

    view.rerender(
      <CreatorResultActions
        generationId={null}
        isPublic={false}
        share={share}
        publicPath={null}
        onPublish={() => {}}
        download={{ href: 'blob:clip', fileName: 'clip.mp4', label: 'Download video' }}
        onStartAnother={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Publish & share' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});
