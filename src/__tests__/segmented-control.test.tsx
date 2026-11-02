import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl, type SegmentedControlOption } from '@/components/DesignSystem';

const ORDERS: SegmentedControlOption<'top' | 'newest' | 'oldest'>[] = [
  { value: 'top', label: 'Top' },
  { value: 'newest', label: 'New' },
  { value: 'oldest', label: 'Old' },
];

function Picker({ onChange = vi.fn(), ...props }: Partial<Parameters<typeof SegmentedControl<'top' | 'newest' | 'oldest'>>[0]>) {
  const [value, setValue] = useState<'top' | 'newest' | 'oldest'>('top');
  return (
    <SegmentedControl
      ariaLabel="Sort comments"
      options={ORDERS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      {...props}
    />
  );
}

/**
 * The web's one segmented control (`DesignSystem.tsx`), drawn as the app's is.
 * Until November 2026 the web drew it five times by hand, plus the creators'
 * pill, with three selected fills and three ARIA patterns.
 */
describe('SegmentedControl', () => {
  it('is a radio group by default, one stop in the tab order on the choice in use', () => {
    render(<Picker />);
    const group = screen.getByRole('radiogroup', { name: 'Sort comments' });
    const radios = screen.getAllByRole('radio');
    expect(group).toContainElement(radios[0]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves the choice with the arrow keys, Home and End, and takes the focus with it', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const top = screen.getByRole('radio', { name: 'Top' });
    top.focus();

    fireEvent.keyDown(top, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('newest');
    expect(screen.getByRole('radio', { name: 'New' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'New' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'New' }), { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Old' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Old' }), { key: 'ArrowRight' });
    // Round past the end, as a radio group does.
    expect(screen.getByRole('radio', { name: 'Top' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Top' }), { key: 'Home' });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('answers only a real change', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Top' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Old' }));
    expect(onChange).toHaveBeenCalledWith('oldest');
  });

  it('is a tab list when it switches what is shown, each tab naming itself and its panel', () => {
    render(
      <SegmentedControl
        role="tab"
        ariaLabel="Profile media"
        options={[
          { value: 'posts', label: 'Posts', count: 8, id: 'profile-tab-posts', controls: 'profile-panel-posts' },
          { value: 'saved', label: 'Saved', count: 3, id: 'profile-tab-saved', controls: 'profile-panel-saved' },
        ]}
        value="posts"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('tablist', { name: 'Profile media' })).toBeInTheDocument();
    // The count is part of the name, a space apart: "Posts 8", never "Posts8".
    const posts = screen.getByRole('tab', { name: 'Posts 8', selected: true });
    expect(posts).toHaveAttribute('id', 'profile-tab-posts');
    expect(posts).toHaveAttribute('aria-controls', 'profile-panel-posts');
    expect(screen.getByRole('tab', { name: 'Saved 3', selected: false })).toBeInTheDocument();
  });

  it('draws one shape: a capsule track in the inset fill, and the choice in use a coral capsule inside it', () => {
    render(<Picker />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveClass('rounded-full', 'border', 'border-[var(--ui-border-subtle)]', 'bg-[var(--ui-surface-inset)]', 'flex');
    const [chosen, other] = screen.getAllByRole('radio');
    expect(chosen).toHaveClass('rounded-full', 'min-h-11.5', 'flex-1');
    expect(chosen.firstElementChild).toHaveClass('rounded-full', 'min-h-9.5', 'bg-[var(--ui-primary)]', 'text-[var(--ui-primary-on)]');
    expect(other.firstElementChild).not.toHaveClass('bg-[var(--ui-primary)]');
  });

  it('sizes each segment to its words beside a heading, and comes compact for a dense row', () => {
    render(<Picker fill={false} size="compact" />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveClass('inline-flex');
    const [chosen] = screen.getAllByRole('radio');
    expect(chosen).toHaveClass('shrink-0', 'min-h-8.5');
    expect(chosen.firstElementChild).toHaveClass('min-h-7.5');
  });
});

/**
 * The guard the radius guard cannot be: a segmented control a page draws for
 * itself drifts from the shared one, as the sign-in switch did (Sign in chose a
 * grey thumb and Sign up a coral one). Its signature: a capsule track (rounded
 * and padded) whose children are choices with a pressed, selected or checked
 * state. It was true of all six that `SegmentedControl` replaced.
 */
const sourceRoot = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

function capsuleTracks(source: string) {
  const found: number[] = [];
  const pattern = /<div\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{' || character === '(') depth += 1;
      else if (character === '}' || character === ')') depth -= 1;
      else if (character === '>' && depth === 0) { end = index + 1; break; }
    }
    if (end === -1) continue;
    const tag = source.slice(match.index, end);
    if (!tag.includes('rounded-full') || !/(^|[\s'"`])p[xy]?-(0\.5|1|1\.5)([\s'"`]|$)/.test(tag)) continue;
    const body = source.slice(end, end + 1500);
    const choices = body.match(/aria-(pressed|selected|checked)=|role="(tab|radio)"/g) ?? [];
    if (choices.length >= 2 || (choices.length === 1 && body.includes('.map('))) {
      found.push(source.slice(0, match.index).split('\n').length);
    }
  }
  return found;
}

describe('one segmented control on the web', () => {
  it('finds the hand-drawn control it replaced', () => {
    // The sign-in switch as it was, so a clean run below means "none found", not "none looked at".
    const loginSwitch = `
      <div className="mb-6 grid grid-cols-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-1" role="group">
        <button type="button" aria-pressed={isLogin} className="rounded-full">Sign in</button>
        <button type="button" aria-pressed={!isLogin} className="rounded-full">Sign up</button>
      </div>`;
    expect(capsuleTracks(loginSwitch)).toEqual([2]);
  });

  it('draws every segmented control with SegmentedControl', () => {
    const found = sourceFiles(sourceRoot)
      .filter((file) => path.relative(sourceRoot, file) !== path.join('components', 'DesignSystem.tsx'))
      .flatMap((file) => capsuleTracks(readFileSync(file, 'utf8')).map((line) => `${path.relative(sourceRoot, file)}:${line}`));
    expect(found).toEqual([]);
  });
});
