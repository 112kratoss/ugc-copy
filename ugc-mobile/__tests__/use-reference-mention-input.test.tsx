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

  function mount(initialPrompt = '') {
    const focus = vi.fn();
    const setNativeProps = vi.fn();
    const onMentionStateChange = vi.fn();
    let field!: Field;
    let prompt = initialPrompt;
    let renders = 0;
    // A composer: its draft holds what the field shows and takes each change to it.
    function Composer({ enabled }: { enabled: boolean }) {
      const [text, setText] = useState(initialPrompt);
      prompt = text;
      renders += 1;
      field = useReferenceMentionInput({ prompt: text, enabled, onPromptChange: setText, onFocus: () => {}, onBlur: () => {}, onMentionStateChange });
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Composer enabled />); });
    Object.assign(field.inputRef, { current: { focus, setNativeProps } });
    return {
      focus,
      setNativeProps,
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
    expect(composer.setNativeProps).toHaveBeenCalledWith({ selection: { start: 24, end: 24 } });

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
    expect(composer.setNativeProps).toHaveBeenCalledWith({ selection: { start: 22, end: 22 } });

    // The insert took the blur's 160 ms back: the field still counts as focused, so a caret the
    // creator puts at the end of the handle opens the list.
    composer.select(21);
    expect(composer.field.activeMention).toEqual({ start: 13, end: 21, query: 'flowers' });
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
