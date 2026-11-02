import React, { useLayoutEffect, useState } from 'react';
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

  /**
   * `afterCommit` runs in the composer's own layout effect, after the hook's: what the field sends
   * there arrives between a render's commit and its passive effects, as keystrokes did on the Pixel 9a.
   */
  function mount(initialPrompt = '', { afterCommit }: { afterCommit?: (text: string, field: Field) => void } = {}) {
    const focus = vi.fn();
    const setSelection = vi.fn();
    const onMentionStateChange = vi.fn();
    let field!: Field;
    let prompt = initialPrompt;
    let renders = 0;
    let setDraftPrompt!: (text: string) => void;
    const mentions: Array<Field['activeMention']> = [];
    // A composer: its draft holds what the field shows and takes each change to it.
    function Composer({ enabled }: { enabled: boolean }) {
      const [text, setText] = useState(initialPrompt);
      prompt = text;
      setDraftPrompt = setText;
      renders += 1;
      field = useReferenceMentionInput({ prompt: text, enabled, onPromptChange: setText, onFocus: () => {}, onBlur: () => {}, onMentionStateChange });
      mentions.push(field.activeMention);
      useLayoutEffect(() => { afterCommit?.(text, field); });
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
      /** The mention each render had open, in order. */
      mentions,
      act: (run: () => void) => renderer.act(run),
      focusField: () => renderer.act(() => { field.inputProps.onFocus(); }),
      blur: () => renderer.act(() => { field.inputProps.onBlur(); }),
      /** Text as a person types it: the change, then the caret at its end. */
      type: (text: string) => {
        renderer.act(() => { field.inputProps.onChangeText(text); });
        renderer.act(() => { field.inputProps.onSelectionChange(caret(text.length)); });
      },
      /** A keystroke as the field delivers it: the change and its caret in one batch. */
      keystroke: (text: string) => renderer.act(() => {
        field.inputProps.onChangeText(text);
        field.inputProps.onSelectionChange(caret(text.length));
      }),
      select: (start: number, end = start) => renderer.act(() => { field.inputProps.onSelectionChange(caret(start, end)); }),
      /** The draft changing the prompt itself, as a saved draft arriving, Enhance or a rename does. */
      replace: (text: string) => renderer.act(() => { setDraftPrompt(text); }),
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

  // iOS reports neither the caret its text replacement leaves nor the one put back (the review of
  // #660): the creator's own return to that caret is theirs, and opens the list.
  it('leaves the list to the creator after an insert the field never reports back', () => {
    const composer = mount();
    composer.focusField();
    composer.type('@ali walks in, then @');
    composer.act(() => { composer.field.insertHandleAtMention('@ali'); });
    composer.wait(0);
    expect(composer.setSelection).toHaveBeenCalledWith(24, 24);

    composer.select(4);
    expect(composer.field.activeMention).toEqual({ start: 0, end: 4, query: 'ali' });
    composer.select(24);
    expect(composer.field.activeMention).toEqual({ start: 20, end: 24, query: 'ali' });
  });

  // A handle typed in full and then picked changes nothing, so Android reports nothing either.
  it('leaves the list to the creator after an insert that changed nothing', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to @hero');
    composer.act(() => { composer.field.insertHandleAtMention('@hero'); });
    expect(composer.prompt).toBe('Walk to @hero');
    composer.wait(0);

    composer.select(2);
    composer.select(13);
    expect(composer.field.activeMention).toEqual({ start: 8, end: 13, query: 'hero' });
  });

  it('puts no caret back over one the creator placed, or typed past, before the sheet’s delay ran out', () => {
    const placed = mount('Place beside the vase.');
    placed.focusField();
    placed.select(13);
    placed.blur();
    placed.act(() => { placed.field.insertHandleAtCaret('@flowers', 280); });
    placed.select(3);
    placed.wait(280);
    expect(placed.focus).toHaveBeenCalledTimes(1);
    expect(placed.setSelection).not.toHaveBeenCalled();

    // Typed inside the new handle, where the field's carets read as the insert's own: the keystroke
    // alone ends the wait.
    const typed = mount('Walk to ');
    typed.focusField();
    typed.select(8);
    typed.act(() => { typed.field.insertHandleAtCaret('@hero', 280); });
    typed.act(() => {
      typed.field.inputProps.onChangeText('Walk to @hxero');
      typed.field.inputProps.onSelectionChange(caret(10));
    });
    typed.wait(280);
    expect(typed.setSelection).not.toHaveBeenCalled();
  });

  it('forgets an insert’s caret when the field goes, so the creator’s own return to it opens the list', () => {
    const composer = mount();
    composer.focusField();
    composer.type('Walk to @');
    composer.act(() => { composer.field.insertHandleAtMention('@hero'); });
    expect(composer.prompt).toBe('Walk to @hero');
    composer.enable(false);
    composer.enable(true);
    composer.focusField();
    composer.select(13);
    expect(composer.field.activeMention).toEqual({ start: 8, end: 13, query: 'hero' });
  });

  // Keystrokes reached the field between a render's commit and its passive effects on the Pixel 9a
  // emulator (trace, 2026-11-02): a passive sync then took that render's prompt, the field's own
  // older text, for an outside change and moved the caret back, closing the list for a render.
  it('keeps up with keystrokes that reach the field right after a render', () => {
    let sent = false;
    const composer = mount('', {
      afterCommit: (text, field) => {
        if (sent || text !== 'Go @h') return;
        sent = true;
        field.inputProps.onChangeText('Go @he');
        field.inputProps.onSelectionChange(caret(6));
      },
    });
    composer.focusField();
    composer.keystroke('Go @');
    expect(composer.field.activeMention).toEqual({ start: 3, end: 4, query: '' });
    const opened = composer.mentions.length - 1;

    composer.keystroke('Go @h');
    expect(composer.prompt).toBe('Go @he');
    expect(composer.field.activeMention).toEqual({ start: 3, end: 6, query: 'he' });
    expect(composer.mentions.slice(opened)).not.toContain(null);
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

    // A video story writes its shots: the single shot's field goes without a blur. No render of the
    // field turned off has the list open, not even the one before its focus is dropped.
    const before = composer.mentions.length;
    const told = composer.onMentionStateChange.mock.calls.length;
    composer.enable(false);
    expect(composer.field.activeMention).toBeNull();
    expect(composer.mentions.slice(before)).toEqual(composer.mentions.slice(before).map(() => null));
    expect(composer.onMentionStateChange.mock.calls.slice(told)).not.toContainEqual([true]);
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

  // iOS keeps its caret's distance from the end and Android moves it in proportion: the field's
  // caret is put where the hook's goes, so an insert lands at the caret the creator sees.
  it('puts the field’s caret where an outside change leaves the hook’s', () => {
    const composer = mount('A cat on a sofa');
    composer.focusField();
    composer.select(5);
    composer.replace('A cat on a velvet sofa, soft light');
    expect(composer.setSelection).toHaveBeenLastCalledWith(5, 5);
    composer.act(() => { composer.field.insertHandleAtCaret('@flowers', 280); });
    expect(composer.prompt).toBe('A cat @flowers on a velvet sofa, soft light');
  });

  it('drops an insert’s pending caret when the prompt changes before it is put back', () => {
    const composer = mount('Walk to ');
    composer.focusField();
    composer.select(8);
    composer.blur();
    composer.act(() => { composer.field.insertHandleAtCaret('@hero', 280); });
    composer.replace('Run to @hero');
    expect(composer.setSelection).toHaveBeenLastCalledWith(12, 12);
    composer.wait(280);
    expect(composer.setSelection).not.toHaveBeenCalledWith(13, 13);
    expect(composer.setSelection).toHaveBeenLastCalledWith(12, 12);
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
