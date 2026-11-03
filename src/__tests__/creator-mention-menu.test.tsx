import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  CreatorMentionMenu,
  useCreatorMentionMenu,
  type CreatorMention,
  type CreatorMentionSuggestion,
} from '@/components/CreatorMentionMenu';
import { getMentionQueryAtCaret, insertHandleIntoPrompt } from '@/lib/image-elements';

const REFERENCES: CreatorMentionSuggestion[] = [
  { id: 'ali', displayName: 'Ali', handle: '@ali', kind: 'image', previewUrl: 'blob:ali' },
  { id: 'pic', displayName: 'Pic', handle: '@pic', kind: 'video', previewUrl: 'https://example.test/pic.mp4' },
];

/** A prompt wired as the creators wire theirs: the mention at the caret, the matches, and the insert. */
function Prompt({ references = REFERENCES, scope }: { references?: CreatorMentionSuggestion[]; scope?: string }) {
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const [prompt, setPrompt] = useState('');
  const [mention, setMention] = useState<CreatorMention | null>(null);
  const check = (value: string, caret?: number) => {
    setMention(getMentionQueryAtCaret(value, caret ?? textarea?.selectionStart ?? value.length));
  };
  const query = mention?.query.toLowerCase() ?? '';
  const matches = mention
    ? references.filter((reference) => reference.handle.includes(`@${query}`) || reference.displayName.toLowerCase().includes(query))
    : [];
  const menu = useCreatorMentionMenu({
    mention,
    scope,
    suggestions: matches,
    onInsert: (handle) => {
      const next = insertHandleIntoPrompt(prompt, handle, prompt.length, prompt.length, mention);
      setPrompt(next.prompt);
      setMention(null);
    },
  });
  return (
    <div className="relative">
      <textarea
        aria-label="Prompt"
        ref={setTextarea}
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          check(event.target.value, event.target.value.length);
        }}
        {...menu.field({ onCaretMove: () => check(prompt) })}
      />
      {menu.open ? (
        <CreatorMentionMenu menu={menu.menu} field={() => textarea} noun="reference" prompt={prompt} handleClassName={() => 'text-sky-300'} />
      ) : null}
    </div>
  );
}

const field = () => screen.getByRole('textbox', { name: 'Prompt' });
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const menu = () => screen.queryByRole('listbox', { name: 'References' });

describe('the "@" menu', () => {
  it('offers each reference with its picture, name and handle, and says which the prompt names already', () => {
    render(<Prompt />);
    expect(menu()).toBeNull();

    type('@ali walks in, then @');

    const options = within(menu()!).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'Insert @ali, Ali, already in the prompt',
      'Insert @pic, Pic',
    ]);
    expect(options[0]).toHaveTextContent('In prompt');
    expect(options[0].querySelector('img')).toHaveAttribute('src', 'blob:ali');
    // A clip shows its first moment, still.
    expect(options[1].querySelector('video')).toHaveAttribute('src', 'https://example.test/pic.mp4#t=0.1');
    expect(screen.getByText('2 references')).toBeInTheDocument();
    // The prompt keeps the focus: the rows are its options.
    expect(field()).toHaveAttribute('aria-controls', menu()!.id);
    expect(field()).toHaveAttribute('aria-activedescendant', options[0].id);
  });

  it('counts a handle typed out in full as the mention, not as one the prompt holds', () => {
    render(<Prompt />);
    type('Open on @ali');
    expect(within(menu()!).getByRole('option')).toHaveAccessibleName('Insert @ali, Ali');
  });

  it('moves through the rows with the arrow keys and puts one in with Enter', () => {
    render(<Prompt />);
    type('Open on @');

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    const second = within(menu()!).getAllByRole('option')[1];
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(field()).toHaveAttribute('aria-activedescendant', second.id);
    // Up from the first row wraps to the last, and back.
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(within(menu()!).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(false);
    expect(field()).toHaveValue('Open on @pic');
    // The caret now sits at the end of the handle put in, which reads as a mention:
    // the Enter's own keyup does not open the menu on it again.
    fireEvent.keyUp(field(), { key: 'Enter' });
    expect(menu()).toBeNull();
  });

  it('puts the row in with Tab too, and leaves Shift+Enter to the prompt', () => {
    render(<Prompt />);
    type('Open on @');

    expect(fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(field()).toHaveValue('Open on @');

    expect(fireEvent.keyDown(field(), { key: 'Tab' })).toBe(false);
    expect(field()).toHaveValue('Open on @ali');
  });

  it('puts the row pressed in, without taking the focus from the prompt', () => {
    render(<Prompt />);
    type('Open on @p');
    const option = within(menu()!).getByRole('option', { name: /^Insert @pic/ });

    // A press that took the focus would move the caret out of the prompt first.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(field()).toHaveValue('Open on @pic');
    expect(menu()).toBeNull();
  });

  it('stays away after Escape until the caret leaves that "@"', () => {
    render(<Prompt />);
    type('Open on @');

    expect(fireEvent.keyDown(field(), { key: 'Escape' })).toBe(false);
    expect(menu()).toBeNull();
    fireEvent.keyUp(field(), { key: 'Escape' });
    type('Open on @p');
    expect(menu()).toBeNull();

    type('Open on ');
    type('Open on @');
    expect(menu()).not.toBeNull();
  });

  it('leaves an input method\'s Enter to the input method', () => {
    render(<Prompt />);
    type('Open on @');
    expect(fireEvent.keyDown(field(), { key: 'Enter', isComposing: true })).toBe(true);
    // Safari's Enter that ends the composition no longer says it composes, but keeps keyCode 229.
    expect(fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(field()).toHaveValue('Open on @');
  });

  it('keeps Escape to the prompt it was pressed in, where prompts share the menu', () => {
    const { rerender } = render(<Prompt scope="shot-1" />);
    type('@');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(menu()).toBeNull();

    // Another shot with its own "@" at the same place: its menu is not the one put away.
    rerender(<Prompt scope="shot-2" />);
    expect(menu()).not.toBeNull();
  });

  it('shuts when the prompt loses the focus, and opens again when it comes back', () => {
    render(<Prompt />);
    fireEvent.focus(field());
    type('Open on @');

    fireEvent.blur(field());
    expect(menu()).toBeNull();
    fireEvent.focus(field());
    expect(menu()).not.toBeNull();
  });

  it('leaves the keys to the prompt while it is shut', () => {
    render(<Prompt />);
    type('Open on');
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(field(), { key: 'ArrowDown' })).toBe(true);
  });

  it('says why it has no rows', () => {
    const { unmount } = render(<Prompt />);
    type('Open on @zz');
    expect(screen.getByText('0 references')).toBeInTheDocument();
    expect(screen.getByText(/^No references match/)).toHaveTextContent('No references match “@zz”.');
    // With no rows, Enter is the prompt's.
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(true);
    unmount();

    render(<Prompt references={[]} />);
    type('Open on @');
    expect(screen.getByText('Add a reference to mention it here.')).toBeInTheDocument();
  });
});
