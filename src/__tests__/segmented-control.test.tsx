import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import ts from 'typescript';
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

  it('takes Up and Down in a radio group, and leaves them to the page in a tab list', () => {
    // fireEvent says false when the key's default was prevented.
    const onChange = vi.fn();
    const { unmount } = render(<Picker onChange={onChange} />);
    expect(fireEvent.keyDown(screen.getByRole('radio', { name: 'Top' }), { key: 'ArrowDown' })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith('newest');
    unmount();

    // A horizontal tab list keeps Up and Down for scrolling, and for the reel's previous and next post.
    const onTabChange = vi.fn();
    render(<Picker role="tab" onChange={onTabChange} />);
    const top = screen.getByRole('tab', { name: 'Top' });
    expect(fireEvent.keyDown(top, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(top, { key: 'ArrowUp' })).toBe(true);
    expect(onTabChange).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(top, { key: 'ArrowRight' })).toBe(false);
    expect(onTabChange).toHaveBeenLastCalledWith('newest');
  });

  it('answers only a real change', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Top' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Old' }));
    expect(onChange).toHaveBeenCalledWith('oldest');
  });

  it('leaves a key held with Alt, Ctrl or Cmd to the browser (Alt+← and Cmd+← go back)', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const top = screen.getByRole('radio', { name: 'Top' });
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(fireEvent.keyDown(top, { key: 'ArrowRight', [modifier]: true })).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is two pressed-or-not buttons where the page around it owns the arrow keys', () => {
    // The comment order in the reel, whose ← and → step through posts.
    const onChange = vi.fn();
    render(<Picker role="toggle" onChange={onChange} />);
    expect(screen.getByRole('group', { name: 'Sort comments' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    // Each a stop in the tab order, and no arrow is taken.
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, 0, 0]);
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'Home', 'End']) {
      expect(fireEvent.keyDown(buttons[0], { key })).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(onChange).toHaveBeenCalledWith('newest');
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true');
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
 * grey thumb and Sign up a coral one). Its signature is a shape, read through
 * TypeScript's parser as the radius guard reads its classes: a capsule track
 * (`rounded-full` with a small padding) holding two or more capsule buttons, or
 * buttons mapped over options, whose look or ARIA follows a chosen state. ARIA
 * is not part of it: the composer's Media or Text switch had none and passed the
 * first version of this guard, which looked for ARIA in the text after a `<div`.
 */
const sourceRoot = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

const CAPSULE = /(^|\s)rounded-full(\s|$)/;
const TRACK_PADDING = /(^|\s)p[xy]?-(0\.5|1|1\.5)(\s|$)/;
const CHOICE_STATE = ['aria-pressed', 'aria-selected', 'aria-checked'];

function handDrawnSegments(text: string): number[] {
  const sourceFile = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const attribute = (element: ts.JsxOpeningLikeElement, name: string) => element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
  );
  /** Every string piece of an attribute's value: a class list however it is built. */
  const attributeText = (element: ts.JsxOpeningLikeElement, name: string) => {
    const found = attribute(element, name);
    if (!found) return null;
    const pieces: string[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) pieces.push(node.text);
      ts.forEachChild(node, collect);
    };
    if (found.initializer) collect(found.initializer);
    return pieces.join(' ');
  };
  /** A value that changes with state: a ternary, `&&` or `||` anywhere in it. */
  const dependsOnState = (element: ts.JsxOpeningLikeElement, name: string) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isConditionalExpression(node)
        || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind))) found = true;
      else ts.forEachChild(node, visit);
    };
    const initializer = attribute(element, name)?.initializer;
    if (initializer) visit(initializer);
    return found;
  };
  /** A capsule `<button>` whose ARIA or look says whether it is the one chosen. */
  const isChoice = (element: ts.JsxOpeningLikeElement) => element.tagName.getText(sourceFile) === 'button'
    && CAPSULE.test(attributeText(element, 'className') ?? '')
    && (CHOICE_STATE.some((name) => attribute(element, name) !== undefined)
      || /\b(tab|radio)\b/.test(attributeText(element, 'role') ?? '')
      || dependsOnState(element, 'className'));
  /**
   * The choices a track holds, through layout wrappers (the creator tabs' grid
   * sat inside their track): each mapped one counts as two.
   */
  const choicesIn = (track: ts.JsxElement) => {
    let count = 0;
    const visit = (node: ts.Node, mapped: boolean) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const element = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = element.tagName.getText(sourceFile);
        if (isChoice(element)) count += mapped ? 2 : 1;
        if (isChoice(element) || !ts.isJsxElement(node) || !/^[a-z]/.test(tag) || tag === 'button') return;
      }
      const maps = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map';
      ts.forEachChild(node, (child) => visit(child, mapped || maps));
    };
    track.children.forEach((child) => visit(child, false));
    return count;
  };

  const found: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && /^[a-z]/.test(node.openingElement.tagName.getText(sourceFile))) {
      const classes = attributeText(node.openingElement, 'className') ?? '';
      if (CAPSULE.test(classes) && TRACK_PADDING.test(classes) && choicesIn(node) >= 2) {
        found.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('one segmented control on the web', () => {
  it('finds the hand-drawn controls it replaced, with or without ARIA', () => {
    // The sign-in switch as it was, so a clean run below means "none found", not "none looked at".
    const loginSwitch = `
      <div className="mb-6 grid grid-cols-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] p-1" role="group">
        <button type="button" aria-pressed={isLogin} className="rounded-full">Sign in</button>
        <button type="button" aria-pressed={!isLogin} className="rounded-full">Sign up</button>
      </div>`;
    expect(handDrawnSegments(loginSwitch)).toEqual([2]);

    // The composer's Media or Text switch: no ARIA at all, only the fill following the mode.
    const proofSwitch = `
      <div className="inline-flex rounded-full border border-white/10 bg-black/30 p-1">
        <button type="button" onClick={() => setProofMode('media')} className={\`rounded-full px-4 py-2 \${proofMode === 'media' ? 'bg-sky-300' : 'text-zinc-300'}\`}>Media</button>
        <button type="button" onClick={switchToTextProof} className={\`rounded-full px-4 py-2 \${proofMode === 'text' ? 'bg-sky-300' : 'text-zinc-300'}\`}>Text</button>
      </div>`;
    expect(handDrawnSegments(proofSwitch)).toEqual([2]);

    // And tabs mapped over options, a ">" inside a class string before them.
    const mappedTabs = `
      <nav role="tablist" className="flex rounded-full bg-black/40 p-1 [&>button]:min-w-0">
        {TABS.map((tab) => (
          <button key={tab.id} role="tab" aria-selected={tab.id === active} className="flex-1 rounded-full">{tab.label}</button>
        ))}
      </nav>`;
    expect(handDrawnSegments(mappedTabs)).toEqual([2]);

    // The creator page's tabs: the track padded around a grid that holds the mapped tabs.
    const creatorTabs = `
      <div className="sticky top-16 rounded-full border border-white/8 bg-black/80 p-1.5">
        <div className="grid grid-cols-3 gap-1" role="tablist">
          {tabs.map((tab) => (
            <button key={tab.id} role="tab" className={\`rounded-full px-2 \${tab.id === active ? 'bg-white' : 'text-zinc-400'}\`}>{tab.label}</button>
          ))}
        </div>
      </div>`;
    expect(handDrawnSegments(creatorTabs)).toEqual([2]);

    // One capsule action in a padded capsule is not a choice among options.
    const enhanceChip = `
      <div className="flex rounded-full p-1">
        <button type="button" className={\`rounded-full \${ready ? 'bg-coral' : 'bg-zinc-900'}\`}>Enhance</button>
      </div>`;
    expect(handDrawnSegments(enhanceChip)).toEqual([]);
  });

  it('draws every segmented control with SegmentedControl', () => {
    const files = sourceFiles(sourceRoot)
      .filter((file) => path.relative(sourceRoot, file) !== path.join('components', 'DesignSystem.tsx'));
    // A walk that read nothing would pass: it reads the app's pages and the controls' old homes.
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((file) => path.relative(sourceRoot, file))).toEqual(expect.arrayContaining([
      path.join('components', 'PostComments.tsx'),
      path.join('app', 'post', 'new', 'NewPostClient.tsx'),
      path.join('app', 'login', 'LoginClient.tsx'),
    ]));
    const found = files
      .flatMap((file) => handDrawnSegments(readFileSync(file, 'utf8')).map((line) => `${path.relative(sourceRoot, file)}:${line}`));
    expect(found).toEqual([]);
  });
});
