import { readFileSync } from 'node:fs';
import path from 'node:path';

import postcss, { type AtRule, type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setAppShellSidebarHidden } from '@/lib/app-shell-sidebar';
import { APP_SHELL_SIDEBAR_RESTORE } from '@/lib/app-shell-sidebar-restore';

// The sidebar hidden from the top bar's toggle (owner, 2026-11-02), kept in this browser and
// drawn from the first paint: the root layout marks the root element inline, the stylesheet
// reads the mark. The toggle itself is app-shell-client.test.tsx's; the first paint without
// the page's script is tests/e2e/app-shell-sidebar.spec.ts's.

const ROOT = process.cwd();
const sheet = postcss.parse(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));

/** Each rule for exactly `selector`, with the media query it sits in (null: every width). */
function rulesFor(selector: string) {
  const found: Array<{ media: string | null; declarations: Record<string, string> }> = [];
  sheet.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : null;
    const declarations: Record<string, string> = {};
    rule.walkDecls((declaration) => { declarations[declaration.prop] = declaration.value; });
    found.push({ media: parent ? `@${parent.name} ${parent.params}` : null, declarations });
  });
  return found;
}

const restore = () => new Function(APP_SHELL_SIDEBAR_RESTORE)();

describe('the sidebar kept hidden in this browser', () => {
  afterEach(() => {
    delete document.documentElement.dataset.sidebar;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is marked on the root element by the inline script, and only when it was hidden', () => {
    restore();
    expect(document.documentElement.dataset.sidebar).toBeUndefined();

    window.localStorage.setItem('app-shell-sidebar', 'hidden');
    restore();
    expect(document.documentElement.dataset.sidebar).toBe('hidden');
  });

  it('leaves the page as it is where storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(restore).not.toThrow();
    expect(document.documentElement.dataset.sidebar).toBeUndefined();
  });

  it('is kept by the toggle for the next page, and forgotten when the sidebar is shown again', () => {
    setAppShellSidebarHidden(true);
    expect(document.documentElement.dataset.sidebar).toBe('hidden');
    expect(window.localStorage.getItem('app-shell-sidebar')).toBe('hidden');

    setAppShellSidebarHidden(false);
    expect(document.documentElement.dataset.sidebar).toBeUndefined();
    expect(window.localStorage.getItem('app-shell-sidebar')).toBeNull();
  });

  it('runs in the root layout ahead of the shell', () => {
    const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
    const script = layout.indexOf('<script dangerouslySetInnerHTML={{ __html: APP_SHELL_SIDEBAR_RESTORE }} />');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(layout.indexOf('href="#main-content"'));
  });

  it('gives the page the sidebar\'s column where the sidebar stands beside it, and draws the toggle only there', () => {
    expect(rulesFor("html[data-sidebar='hidden'] .app-shell-root")).toEqual([
      { media: '@media (min-width: 768px)', declarations: { 'grid-template-columns': 'minmax(0, 1fr)' } },
    ]);
    expect(rulesFor("html[data-sidebar='hidden'] .app-shell-sidebar")).toEqual([
      { media: '@media (min-width: 768px)', declarations: { display: 'none' } },
    ]);
    expect(rulesFor('.app-shell-sidebar-toggle')).toEqual([
      { media: null, declarations: { display: 'none' } },
      { media: '@media (min-width: 768px)', declarations: { display: 'inline-flex' } },
    ]);
  });
});
