import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isMinimalAppChromePath } from '@/components/app-shell-nav';

// Below 768px the app shell's bottom navigation floats over the page's bottom edge at z-60
// (`.app-shell-bottom-nav` in globals.css), and it is drawn over anything fixed to that edge at a
// lower layer: there it takes the taps. Until October 2026 it covered the composer's Save private
// and Publish public (z-40), the post page's unlock CTA (z-40), the last models of the model
// picker's phone sheet (z-50), the last row of a feed card's menu (z-50, placed by script), and,
// before them, the workflow canvas's dialogs and the creator page's profile editor (z-50).
//
// So every element of the web app positioned `fixed`, wherever its classes or a script place it,
// does one of these (docs/design/design-web.md, "Layers"):
// - sits above the nav: its bottom offset adds `--app-shell-bottom-nav-space` (0px from 768px);
// - is drawn over it: a layer above 60 (z-[70] and up);
// - draws nothing that takes the pointer (`pointer-events-none` at no layer above the page);
// - is hidden below 768px (`hidden md:flex`), or lives on a route the shell draws without the nav.
// It reads each class list as one line of this codebase writes it: the quoted string that holds
// `fixed`, with the static classes of the template literal it sits in, one list for each branch of
// a ternary. A `fixed` whose positioning classes are in another string, or on another line, is not
// seen.

const ROOT = process.cwd();
const SCANNED = ['src/app', 'src/components'];
// Routes the shell draws without its chrome, bottom navigation included (isMinimalAppChromePath).
const WITHOUT_NAV = ['admin', 'auth', 'child-safety', 'login', 'r'];
// Inside another overlay's layer, where the class's own layer is local.
const INSIDE_ANOTHER_LAYER: Array<{ file: string; classes: string; count: number; why: string }> = [
  {
    file: 'src/app/create-workflow/WorkflowCanvasShareActions.tsx',
    classes: 'fixed inset-0 z-[60] flex items-center justify-center p-6',
    count: 2,
    why: 'the share and import dialogs, inside OverlayShell (fixed z-[80]) in the same file',
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return relative === 'src/app/api' ? [] : sourceFiles(relative);
    return entry.name.endsWith('.tsx') ? [relative] : [];
  });
}

function routeWithoutNav(file: string) {
  const segment = file.startsWith('src/app/') ? file.split('/')[2] : null;
  return segment !== null && WITHOUT_NAV.includes(segment);
}

type Placement = { file: string; line: number; text: string; verdict: string | null };

const LAYER = /^z-(?:(\d+)|\[(\d+)\])$/;
const POSITIONED = /^(?:inset|top|bottom|left|right|z)-|^pointer-events-/;
const SHOWN_FROM_MD = /^(?:md|lg|xl|2xl):(?:flex|block|grid|inline-flex|inline-block|inline|table|contents)$/;

// Why a `fixed` class list is clear of the nav, or null when it is not.
function classifyFixedClasses(tokens: string[]): string | null {
  if (tokens.some((token) => token.startsWith('bottom-[') && token.includes('var(--app-shell-bottom-nav-space'))) return 'above the nav';
  const layers = tokens.map((token) => LAYER.exec(token)).filter(Boolean).map((match) => Number(match![1] ?? match![2]));
  const layer = layers.length > 0 ? Math.max(...layers) : null;
  if (layer !== null && layer >= 70) return 'over the nav';
  if (tokens.includes('pointer-events-none') && (layer === null || layer <= 0)) return 'takes no pointer';
  if (tokens.includes('hidden') && tokens.some((token) => SHOWN_FROM_MD.test(token))) return 'hidden below 768px';
  return null;
}

const QUOTED = /'([^'\n]*)'|"([^"\n]*)"/g;
const words = (classes: string) => classes.split(/\s+/).filter(Boolean);

// The class lists `fixed` comes with on a line, one for each way the line can draw it: a quoted
// string that holds `fixed`, with the static classes of the template literal it sits in; or, where
// `fixed` is among a template's static classes, those with each string inside its `${…}` in turn.
// One line read as one list mixed a ternary's branches: main's card menu,
// `${usesPortal ? 'fixed' : 'absolute right-0 top-[…]'} z-50 …`, passed on the other branch's `top-`.
function fixedClassLists(text: string): string[][] {
  const lists: string[][] = [];
  const rest = text.replace(/`([^`]*)`/g, (_, body: string) => {
    const strings: string[][] = [];
    const statics = words(body.replace(/\$\{([^{}]*)\}/g, (__, expression: string) => {
      for (const match of expression.matchAll(QUOTED)) strings.push(words(match[1] ?? match[2]));
      return ' ';
    }));
    const fixedStrings = strings.filter((list) => list.includes('fixed'));
    if (fixedStrings.length > 0) lists.push(...fixedStrings.map((list) => [...list, ...statics]));
    else if (statics.includes('fixed')) lists.push(...(strings.length > 0 ? strings.map((list) => [...statics, ...list]) : [statics]));
    return ' ';
  });
  for (const match of rest.matchAll(QUOTED)) {
    const list = words(match[1] ?? match[2]);
    if (list.includes('fixed')) lists.push(list);
  }
  // A class list, not prose that says "fixed": it positions or layers something too.
  return lists.filter((list) => list.some((token) => POSITIONED.test(token)));
}

function fixedPlacements(): Placement[] {
  const found: Placement[] = [];
  for (const file of SCANNED.flatMap(sourceFiles)) {
    if (routeWithoutNav(file)) continue;
    readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((text, index) => {
      const trimmed = text.trim();
      if (/^(?:\/\/|\/\*|\*|\{\/\*)/.test(trimmed)) return;
      const lists = fixedClassLists(text);
      if (lists.length === 0) return;
      const verdicts = lists.map(classifyFixedClasses);
      found.push({ file, line: index + 1, text: trimmed, verdict: verdicts.includes(null) ? null : verdicts[0] });
    });
  }
  return found;
}

describe('overlays and the bottom navigation', () => {
  it('names the routes without a bottom navigation as the shell does', () => {
    for (const segment of WITHOUT_NAV) expect(isMinimalAppChromePath(`/${segment}`) || isMinimalAppChromePath(`/${segment}/x`), segment).toBe(true);
    expect(isMinimalAppChromePath('/post/new')).toBe(false);
    expect(isMinimalAppChromePath('/create-image')).toBe(false);
  });

  it('keeps everything fixed to the window clear of the nav below 768px', () => {
    const placements = fixedPlacements();
    const allowed = new Map(INSIDE_ANOTHER_LAYER.map((entry) => [`${entry.file}|${entry.classes}`, entry]));
    const seen = new Map<string, number>();
    const offending = placements.filter((placement) => {
      if (placement.verdict !== null) return false;
      const key = [...allowed.keys()].find((candidate) => {
        const entry = allowed.get(candidate)!;
        return entry.file === placement.file && placement.text.includes(entry.classes);
      });
      if (!key) return true;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return false;
    }).map((placement) => `${placement.file}:${placement.line}: ${placement.text}`);
    expect(offending, 'fixed to the bottom edge (or placed by script) under the nav\'s layer').toEqual([]);
    // Each allowance still matches what it was written for.
    for (const entry of INSIDE_ANOTHER_LAYER) {
      expect(seen.get(`${entry.file}|${entry.classes}`) ?? 0, `${entry.file}: ${entry.why}`).toBe(entry.count);
    }
  });

  it('sees the overlays it is about, each for the reason it is clear', () => {
    const placements = fixedPlacements();
    const verdictOf = (file: string, snippet: string) => placements.find((placement) => (
      placement.file === file && placement.text.includes(snippet)
    ))?.verdict;
    expect(verdictOf('src/app/post/new/NewPostClient.tsx', 'fixed inset-x-4 bottom-[calc(var(--app-shell-bottom-nav-space')).toBe('above the nav');
    expect(verdictOf('src/app/showcase/[id]/ShowcaseDetailBody.tsx', 'canonical-post-mobile-cta fixed')).toBe('above the nav');
    expect(verdictOf('src/components/StudioModelPicker.tsx', "'fixed inset-x-4")).toBe('above the nav');
    expect(verdictOf('src/app/create-workflow/WorkflowCanvasPanels.tsx', 'fixed bottom-[calc(var(--app-shell-bottom-nav-space')).toBe('above the nav');
    expect(verdictOf('src/app/showcase/ShowcaseFeedInteraction.tsx', "'fixed z-[90]'")).toBe('over the nav');
    expect(verdictOf('src/app/creators/[username]/ProfileActions.tsx', 'fixed inset-0 z-[80]')).toBe('over the nav');
    expect(verdictOf('src/components/GenerationNotifications.tsx', 'pointer-events-none fixed')).toBe('over the nav');
    expect(verdictOf('src/app/showcase/[id]/ShowcaseDetailBody.tsx', 'fixed inset-0 z-0 pointer-events-none')).toBe('takes no pointer');
    expect(verdictOf('src/components/NavigationProgress.tsx', 'fixed inset-x-0 top-0')).toBe('over the nav');
    expect(placements.length).toBeGreaterThan(30);
  });

  it('tells a fixed class list that reaches the bottom edge under the nav from one that does not', () => {
    // What the composer's bar, the post page's CTA and the picker's sheet were.
    expect(classifyFixedClasses('fixed inset-x-4 bottom-4 z-40 lg:hidden'.split(' '))).toBeNull();
    expect(classifyFixedClasses('canonical-post-mobile-cta fixed inset-x-3 bottom-3 z-40 flex'.split(' '))).toBeNull();
    expect(classifyFixedClasses('fixed inset-x-4 bottom-4 z-50 flex sm:absolute'.split(' '))).toBeNull();
    // A body menu at the nav's layer or under it, placed by script.
    expect(classifyFixedClasses('fixed z-50 w-64'.split(' '))).toBeNull();
    expect(classifyFixedClasses('fixed inset-0 z-50 flex'.split(' '))).toBeNull();
    expect(classifyFixedClasses('fixed top-16 left-0 h-full z-40'.split(' '))).toBeNull();
    expect(classifyFixedClasses('fixed inset-x-4 bottom-[calc(var(--app-shell-bottom-nav-space,0px)+1rem)] z-40'.split(' '))).toBe('above the nav');
    expect(classifyFixedClasses('fixed inset-0 z-[80]'.split(' '))).toBe('over the nav');
    expect(classifyFixedClasses('fixed inset-0 pointer-events-none'.split(' '))).toBe('takes no pointer');
    expect(classifyFixedClasses('hidden md:flex fixed bottom-4 z-40'.split(' '))).toBe('hidden below 768px');
    expect(classifyFixedClasses('fixed left-4 top-3 z-[120]'.split(' '))).toBe('over the nav');
    // Along the top edge it still covers the page's own layers, so it takes its layer from the scale too.
    expect(classifyFixedClasses('fixed left-4 top-3'.split(' '))).toBeNull();
    expect(classifyFixedClasses('fixed inset-x-4 z-40'.split(' '))).toBeNull();
  });

  it("reads each branch of a ternary as its own class list", () => {
    const verdicts = (line: string) => fixedClassLists(line).map(classifyFixedClasses);
    // The card menu's line on main: the fixed branch is `fixed` and the shared z-50, under the nav.
    expect(verdicts("className={`${usesPortal ? 'fixed' : 'absolute right-0 top-[calc(100%+0.5rem)]'} z-50 w-64 overflow-hidden`}")).toEqual([null]);
    expect(verdicts("className={`${usesPortal ? 'fixed z-[90]' : 'absolute right-0 top-[calc(100%+0.5rem)] z-50'} w-64`}")).toEqual(['over the nav']);
    // The other branch's layer is not the fixed one's.
    expect(verdicts("className={`${open ? 'fixed bottom-4 z-40' : 'absolute z-[80]'} flex`}")).toEqual([null]);
    // `fixed` among the static classes: each branch in turn.
    expect(verdicts("className={`fixed inset-0 ${open ? 'z-[80]' : 'z-40'}`}")).toEqual(['over the nav', null]);
    expect(verdicts('<div className="fixed inset-0 z-[90]" />')).toEqual(['over the nav']);
    // Prose and option values that say "fixed" are no class lists.
    expect(fixedClassLists("{ value: 'fixed', label: 'Fixed template asset' },")).toEqual([]);
    expect(fixedClassLists("'Use motion transfer, which holds identity fixed by construction.',")).toEqual([]);
    expect(fixedClassLists('value={`${videoModel.durations[0]} sec fixed`}')).toEqual([]);
  });

  it('keeps every fixed rule of the stylesheets over the nav, the nav itself aside', () => {
    for (const sheet of ['src/app/globals.css', 'src/app/non-public-utilities.css']) {
      const css = readFileSync(path.join(ROOT, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*position:\s*fixed[^{}]*)\}/g)) {
        const name = selector.trim();
        if (name === '.app-shell-bottom-nav') continue;
        const layer = Number(/z-index:\s*(-?\d+)/.exec(body)?.[1] ?? Number.NaN);
        expect(layer, `${sheet}: ${name}`).toBeGreaterThanOrEqual(70);
      }
    }
  });
});
