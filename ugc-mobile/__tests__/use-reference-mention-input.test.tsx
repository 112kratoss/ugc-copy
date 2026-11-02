import React, { useState } from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useReferenceMentionInput } from '../lib/use-reference-mention-input';

// The prompt field and @ list both app creators run on (#655). Their screen tests drive it through
// the whole screen, where the field mostly has no native view and the timers are rarely run: what
// an insert puts back on the field, the caret change that comes back from it, and a blur's 160 ms
// are pinned here.
describe('useReferenceMentionInput', () => {
  type Field = ReturnType<typeof useReferenceMentionInput>;
  const caret = (start: number, end = start) => ({ nativeEvent: { selection: { start, end } } }) as never;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** `lagging`: the composer holds each change until `catchUp`, as a render that has not happened yet does. */
  function mount(initialPrompt = '', { lagging = false } = {}) {
    const focus = vi.fn();
    const setSelection = vi.fn();
    const onMentionStateChange = vi.fn();
    let field!: Field;
    let prompt = initialPrompt;
    let renders = 0;
    let setDraftPrompt!: (text: string) => void;
    const held: string[] = [];
    // A composer: its draft holds what the field shows and takes each change to it.
    function Composer({ enabled }: { enabled: boolean }) {
      const [text, setText] = useState(initialPrompt);
      prompt = text;
      setDraftPrompt = setText;
      renders += 1;
      const onPromptChange = lagging ? (next: string) => { held.push(next); } : setText;
      field = useReferenceMentionInput({ prompt: text, enabled, onPromptChange, onFocus: () => {}, onBlur: () => {}, onMentionStateChange });
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Composer enabled />); });
    Object.assign(field.inputRef, { current: { focus, setSelection } });
    return {
      focus,
      setSelection,
      onMentionStateChange,
      get field() { return field; },
      get prompt() { return prompt; },
      get renders() { return renders; },
      act: (run: () => void) => renderer.act(run),
      focusField: () => renderer.act(() => { field.inputProps.onFocus(); }),
      blur: () => renderer.act(() => { field.inputProps.onBlur(); }),
      /** Text as a person types it: the change, then the caret at its end. */
      type: (text: string) => {
        renderer.act(() => { field.inputProps.onChangeText(text); });
        renderer.act(() => { field.inputProps.onSelectionChange(caret(text.length)); });
      },
      select: (start: number, end = start) => renderer.act(() => { field.inputProps.onSelectionChange(caret(start, end)); }),
      /** The draft changing the prompt itself, as a saved draft arriving, Enhance or a rename does. */
      replace: (text: string) => renderer.act(() => { setDraftPrompt(text); }),
      /** A lagging composer taking the changes it held, one render each. */
      catchUp: () => { while (held.length > 0) { const next = held.shift()!; renderer.act(() => { setDraftPrompt(next); }); } },
      enable: (enabled: boolean) => renderer.act(() => { tree.update(<Composer enabled={enabled} />); }),
      unmount: () => renderer.act(() => { tree.unmount(); }),
      wait: (ms: number) => renderer.act(() => { vi.advanceTimersByTime(ms); }),
    };
  }

  it('inserts a handle the prompt already names, and keeps the list shut through the caret the insert puts back', () => {
    const composer = mount();
    composer.focusField();
    composer.type('@ali walks in, then @');
    expect(composer.field.activeMention).toEqual({ start: 20, end: 21, query: '' });
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(true);

    composer.act(() => { composer.field.insertHandleAtMention('@ali'); });
    expect(composer.prompt).toBe('@ali walks in, then @ali');
    // The caret now ends a handle, which reads as a mention being typed: the list stays shut for it.
    expect(composer.field.activeMention).toBeNull();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);

    // From the list, focus and the caret go back at once.
    composer.wait(0);
    expect(composer.focus).toHaveBeenCalledTimes(1);
    expect(composer.setSelection).toHaveBeenCalledWith(24, 24);

    // The field reports that caret back. It is not the creator's, so the list stays shut…
    composer.select(24);
    expect(composer.field.activeMention).toBeNull();

    // …while a caret the creator puts there opens it again.
    composer.select(4);
    expect(composer.field.activeMention).toEqual({ start: 0, end: 4, query: 'ali' });
    composer.select(24);
    expect(composer.field.activeMention).toEqual({ start: 20, end: 24, query: 'ali' });
  });

  it('inserts at the last caret from a sheet over the field, and puts focus back only after its delay', () => {
    const composer = mount('Place beside the vase.');
    composer.focusField();
    composer.select(13);
    composer.blur();

    composer.act(() => { composer.field.insertHandleAtCaret('@flowers', 280); });
    expect(composer.prompt).toBe('Place beside @flowers the vase.');
    composer.wait(279);
    expect(composer.focus).not.toHaveBeenCalled();
    composer.wait(1);
    expect(composer.focus).toHaveBeenCalledTimes(1);
    expect(composer.setSelection).toHaveBeenCalledWith(22, 22);

    // The insert took the blur's 160 ms back: the field still counts as focused, so a caret the
    // creator puts at the end of the handle opens the list.
    composer.select(21);
    expect(composer.field.activeMention).toEqual({ start: 13, end: 21, query: 'flowers' });
  });

  // Android replaces the field's whole text for an insert and reports the caret its replacement
  // left first, here inside the new handle (8 of 18 is 9 of 22), then the one the insert put back.
  it('keeps the list shut when the field reports another caret on the way to the one an insert puts back', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Use @flo for color');
    composer.select(8);
    expect(composer.field.activeMention).toEqual({ start: 4, end: 8, query: 'flo' });

    composer.act(() => { composer.field.insertHandleAtMention('@flowers'); });
    expect(composer.prompt).toBe('Use @flowers for color');
    composer.select(9);
    composer.wait(0);
    expect(composer.setSelection).toHaveBeenCalledWith(12, 12);
    composer.select(12);
    expect(composer.field.activeMention).toBeNull();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);

    composer.select(3);
    composer.select(12);
    expect(composer.field.activeMention).toEqual({ start: 4, end: 12, query: 'flowers' });
  });

  // Two keystrokes can reach the field before React runs the effect of the prompt the first one
  // made (the Pixel 9a emulator's trace, 2026-11-02): that older prompt is the field's own text.
  it('keeps the caret the field typed when the prompt catches up with it a render late', () => {
    const composer = mount('', { lagging: true });
    composer.focusField();
    composer.type('Go @');
    composer.type('Go @h');
    composer.type('Go @he');
    composer.catchUp();
    expect(composer.prompt).toBe('Go @he');
    expect(composer.field.activeMention).toEqual({ start: 3, end: 6, query: 'he' });
  });

  it('shuts the list 160 ms after a blur, unless the field is focused again first', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to @');
    composer.blur();
    composer.wait(159);
    expect(composer.field.activeMention).not.toBeNull();
    composer.wait(1);
    expect(composer.field.activeMention).toBeNull();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);

    composer.focusField();
    expect(composer.field.activeMention).not.toBeNull();
    composer.blur();
    composer.wait(100);
    composer.focusField();
    composer.wait(100);
    expect(composer.field.activeMention).not.toBeNull();
  });

  it('opens no list while the field is not the prompt in use, though it last had focus', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to @');
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(true);

    // A video story writes its shots: the single shot's field goes without a blur.
    composer.enable(false);
    expect(composer.field.activeMention).toBeNull();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);
  });

  // The single shot's field leaves without a blur when the run turns into a story, and comes back
  // unfocused when it turns back: the list stays shut until the creator focuses the field again.
  it('loses focus with the field, so the list does not come back with it', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to @he');
    expect(composer.field.activeMention).toEqual({ start: 8, end: 11, query: 'he' });

    composer.enable(false);
    composer.enable(true);
    expect(composer.field.activeMention).toBeNull();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);

    composer.focusField();
    expect(composer.field.activeMention).toEqual({ start: 8, end: 11, query: 'he' });
  });

  it('puts no focus back on a field that went before the sheet’s delay ran out', () => {
    const composer = mount('Walk to ');
    composer.act(() => { composer.field.insertHandleAtCaret('@hero', 280); });
    composer.enable(false);
    composer.enable(true);
    composer.wait(280);
    expect(composer.focus).not.toHaveBeenCalled();
  });

  // The composers mount on an empty opening draft and the saved draft arrives after it; Enhance,
  // Undo and a rename change the prompt from outside the field too, and neither platform's field
  // says where its caret went.
  it('puts the caret after a prompt that arrives once the field is up, so the sheet inserts after it', () => {
    const composer = mount();
    composer.replace('A cat on a sofa');
    composer.act(() => { composer.field.insertHandleAtCaret('@flowers', 280); });
    expect(composer.prompt).toBe('A cat on a sofa @flowers');
    composer.wait(280);
    expect(composer.setSelection).toHaveBeenCalledWith(24, 24);
  });

  it('keeps the caret between the words it was between when the prompt changes before it', () => {
    const composer = mount('Place @flowers beside the vase');
    composer.focusField();
    composer.select(22);
    composer.blur();
    composer.replace('Place @roses beside the vase');
    composer.act(() => { composer.field.insertHandleAtCaret('@roses', 280); });
    expect(composer.prompt).toBe('Place @roses beside @roses the vase');
  });

  it('leaves the caret where it was when the prompt changes after it', () => {
    const composer = mount('Place beside @flowers');
    composer.focusField();
    composer.select(6);
    composer.blur();
    composer.replace('Place beside @roses');
    composer.act(() => { composer.field.insertHandleAtCaret('@roses', 280); });
    expect(composer.prompt).toBe('Place @roses beside @roses');
  });

  it('tells the composer the list is shut when it goes, and puts no focus back after that', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to ');
    composer.act(() => { composer.field.insertHandleAtCaret('@hero', 280); });
    expect(composer.prompt).toBe('Walk to @hero');
    composer.type('Walk to @hero, then @');
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(true);

    composer.unmount();
    expect(composer.onMentionStateChange).toHaveBeenLastCalledWith(false);
    composer.wait(1000);
    expect(composer.focus).not.toHaveBeenCalled();
  });

  // The video composer's copy set the caret again after every prompt change, an extra render each
  // time; the image composer's skipped a caret already where the prompt leaves it.
  it('renders once for a prompt change that leaves the caret where it was', () => {
    const composer = mount();
    composer.focusField();
    const before = composer.renders;
    composer.act(() => { composer.field.inputProps.onChangeText('W'); });
    expect(composer.renders - before).toBe(1);
  });
});
