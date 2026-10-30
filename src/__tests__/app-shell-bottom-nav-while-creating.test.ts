import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { hidesBottomNav } from '@/components/app-shell-nav';
import { MEDIA_TOOL_IDS } from '@/components/CreatorStudio';
import { CREATOR_PAGE_PATHS } from '@/lib/creator-pages';
import { getCreatorTool } from '@/lib/creator-tools';

// The owner's decision for the phone-width web (2026-10-28, "Hide it while creating"): on the
// image, video and motion creators the shell's bottom navigation hides below 768px, so the
// creator's own bar holds the window's bottom edge, and the top bar's menu reaches every page.
// From 768px no page has the bottom navigation. The shell marks such a page on its root
// (`data-bottom-nav="hidden"`, app-shell-client.test.tsx), and globals.css does the rest.

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

describe('the bottom navigation while creating', () => {
  it('names the media creators the tools name, no more and no fewer', () => {
    expect([...CREATOR_PAGE_PATHS].sort()).toEqual(MEDIA_TOOL_IDS.map((tool) => getCreatorTool(tool).href).sort());
  });

  it('hides on the three creators, a page under one included, and nowhere else', () => {
    for (const tool of MEDIA_TOOL_IDS) {
      const { href } = getCreatorTool(tool);
      expect(hidesBottomNav(href), href).toBe(true);
      expect(hidesBottomNav(`${href}/probe`), `${href}/probe`).toBe(true);
    }
    for (const pathname of [
      '/', '/home', '/showcase', '/showcase/post-1', '/create', '/create-workflow', '/creations',
      '/post/new', '/templates', '/template-runs/run-1', '/notifications', '/profile',
      // Only the creators themselves, not a path that merely starts with their name.
      '/create-videos', '/create-image-batch',
      // The shell's neutral pathname before hydration and on the not-found page.
      '',
    ]) {
      expect(hidesBottomNav(pathname), pathname).toBe(false);
    }
  });

  it('keeps it on every other route the app has', () => {
    const routes = readdirSync(path.join(ROOT, 'src/app'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'api')
      .map((entry) => `/${entry.name}`);
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter(hidesBottomNav).sort()).toEqual(['/create-image', '/create-motion', '/create-video']);
  });

  it('floats it over the page below 768px, with room kept at the end, and none from 768px', () => {
    const nav = rulesFor('.app-shell-bottom-nav');
    expect(nav.find((rule) => rule.media === null)?.declarations).toMatchObject({ position: 'fixed', display: 'flex' });
    expect(nav.find((rule) => rule.media === '@media (min-width: 768px)')?.declarations).toEqual({ display: 'none' });

    const root = rulesFor('.app-shell-root');
    expect(root.find((rule) => rule.media === null && '--app-shell-bottom-nav-space' in rule.declarations)?.declarations['--app-shell-bottom-nav-space'])
      .toBe('calc(6.25rem + env(safe-area-inset-bottom))');
    expect(root.find((rule) => rule.media === '@media (min-width: 768px)' && '--app-shell-bottom-nav-space' in rule.declarations)?.declarations['--app-shell-bottom-nav-space'])
      .toBe('0px');
  });

  it('takes it and its room away on a page that holds the bottom edge, at every width', () => {
    // Not inside a media query: from 768px the nav is gone and its room 0px anyway. The
    // attribute's selector outranks the plain class's, in the 768px query too.
    expect(rulesFor(".app-shell-root[data-bottom-nav='hidden']")).toEqual([
      { media: null, declarations: { '--app-shell-bottom-nav-space': '0px' } },
    ]);
    expect(rulesFor(".app-shell-root[data-bottom-nav='hidden'] .app-shell-bottom-nav")).toEqual([
      { media: null, declarations: { display: 'none' } },
    ]);
  });
});
