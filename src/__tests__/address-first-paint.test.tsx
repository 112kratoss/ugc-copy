import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, renderHook } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AddressFirstPaintRelease from '@/components/AddressFirstPaintRelease';
import { TemplateCard } from '@/components/templates/TemplatePrimitives';
import type { MediaTemplate } from '@/components/templates/types';
import {
  ADDRESS_FIRST_PAINT_MARKS,
  ADDRESS_FIRST_PAINT_RESTORE,
  CREATOR_TAB_MARK,
  HOME_CHIP_MARK,
  readAddressFirstPaintMark,
  TEMPLATE_INPUT_MARK,
} from '@/lib/address-first-paint';
import { useFirstPaintMark } from '@/lib/use-first-paint-mark';

// A choice a page drawn ahead of time keeps in its address, drawn from the first paint (owner,
// 2026-11-15: "fix the … refresh flash too"). The browser's half, with page scripts held back and
// then running: tests/e2e/address-state-first-paint.spec.ts.

const navigation = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a>,
}));

const ROOT = process.cwd();
const root = document.documentElement;

function restoreAt(address: string) {
  window.history.replaceState(null, '', address);
  new Function(ADDRESS_FIRST_PAINT_RESTORE)();
}

afterEach(() => {
  for (const attribute of ADDRESS_FIRST_PAINT_MARKS) root.removeAttribute(attribute);
  window.history.replaceState(null, '', '/');
  navigation.pathname = '/';
});

describe('the mark the address gives a page before it draws', () => {
  it.each([
    ['/?chip=notes', HOME_CHIP_MARK, 'notes'],
    ['/?chip=recent', HOME_CHIP_MARK, 'recent'],
    ['/?chip=unlocks&ref=x', HOME_CHIP_MARK, 'unlocks'],
    ['/creators/someone#creator-unlocks', CREATOR_TAB_MARK, 'unlocks'],
    ['/creators/someone?post=p#creator-tools', CREATOR_TAB_MARK, 'tools'],
    ['/templates?input=image', TEMPLATE_INPUT_MARK, 'image'],
    ['/templates/?input=video', TEMPLATE_INPUT_MARK, 'video'],
    // The defaults, and what names nothing known, are never marked.
    ['/', null, null],
    ['/?chip=for-you', null, null],
    ['/?chip=__proto__', null, null],
    ['/creators/someone', null, null],
    ['/creators/someone#creator-creations', null, null],
    ['/creators/someone#__proto__', null, null],
    ['/creators/someone/extra#creator-unlocks', null, null],
    ['/templates', null, null],
    ['/templates?input=audio', null, null],
    ['/templates/mine?input=image', null, null],
    ['/showcase?chip=notes', null, null],
  ])('%s: %s %s', (address, attribute, value) => {
    restoreAt(address);

    const marked = ADDRESS_FIRST_PAINT_MARKS.filter((name) => root.hasAttribute(name));
    expect(marked).toEqual(attribute ? [attribute] : []);
    if (attribute) expect(root.getAttribute(attribute)).toBe(value);
    const url = new URL(address, 'https://magicbooklet.test');
    expect(readAddressFirstPaintMark(url.pathname, url.search, url.hash))
      .toEqual(attribute ? { attribute, value } : null);
  });

  it('is in the root layout, run ahead of the page', () => {
    const layout = readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain('__html: ADDRESS_FIRST_PAINT_RESTORE');
    expect(layout).toContain('<AddressFirstPaintRelease />');
  });
});

describe('the page taking its choice over', () => {
  it('takes the mark off once it draws the marked choice, not before', () => {
    root.setAttribute(TEMPLATE_INPUT_MARK, 'image');
    const { rerender } = renderHook(({ drawn }) => useFirstPaintMark(TEMPLATE_INPUT_MARK, drawn), {
      // The render that hydrates draws the server's default.
      initialProps: { drawn: null as string | null },
    });
    expect(root.getAttribute(TEMPLATE_INPUT_MARK)).toBe('image');

    rerender({ drawn: 'image' });

    expect(root.hasAttribute(TEMPLATE_INPUT_MARK)).toBe(false);
  });

  it('leaves the shell to take every mark off when the reader goes to another page first', () => {
    navigation.pathname = '/creators/someone';
    root.setAttribute(CREATOR_TAB_MARK, 'unlocks');
    const { rerender } = render(<AddressFirstPaintRelease />);
    expect(root.getAttribute(CREATOR_TAB_MARK)).toBe('unlocks');

    navigation.pathname = '/showcase';
    rerender(<AddressFirstPaintRelease />);

    expect(ADDRESS_FIRST_PAINT_MARKS.some((name) => root.hasAttribute(name))).toBe(false);
  });

  it.each([
    ['src/app/feed/FeedClient.tsx', 'useFirstPaintMark(HOME_CHIP_MARK'],
    ['src/app/creators/[username]/CreatorContentTabs.tsx', 'useFirstPaintMark(CREATOR_TAB_MARK'],
    ['src/components/templates/TemplateCatalogClient.tsx', 'useFirstPaintMark(TEMPLATE_INPUT_MARK'],
  ])('%s takes its mark over', (file, call) => {
    expect(readFileSync(path.join(ROOT, file), 'utf8')).toContain(call);
  });
});

describe('the stylesheet drawing the marked choice', () => {
  const css = postcss.parse(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
  const selectors: string[] = [];
  css.walkRules((rule) => {
    selectors.push(...rule.selectors);
  });

  it.each([
    // Home: the chip, and another lane's posts left out.
    'html[data-home-chip="notes"] [data-feed-chip="notes"]',
    'html[data-home-chip] [data-feed-chip]',
    'html[data-home-chip="notes"] [data-feed-lane-list]:not([data-feed-lane="notes"])',
    // A creator's page: the tab, and only what it shows.
    'html[data-creator-tab="unlocks"] #creator-tab-unlocks > span',
    'html[data-creator-tab] #creator-tab-creations > span',
    'html[data-creator-tab="unlocks"] #creator-panel-creations [data-creator-card]:not([data-creator-recipe])',
    'html[data-creator-tab="tools"] #creator-panel-creations',
    // Templates: the filter, and only the templates it keeps.
    'html[data-template-input="image"] [data-template-input-chip="image"]',
    'html[data-template-input] [data-template-input-chip]',
    'html[data-template-input="video"] [data-template-inputs]:not([data-template-inputs~="video"])',
  ])('%s', (selector) => {
    expect(selectors).toContain(selector);
  });

  it('names the controls and cards those rules find', () => {
    const files = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
    expect(files('src/app/feed/FeedClient.tsx')).toContain('data-feed-chip={chip.id}');
    expect(files('src/app/feed/FeedClient.tsx')).toContain('data-feed-lane-list data-feed-lane={chipId}');
    expect(files('src/components/HomeFeedSkeleton.tsx')).toContain('data-feed-chip={chip.id}');
    expect(files('src/app/creators/[username]/CreatorContentTabs.tsx')).toContain("data-creator-recipe={item.asset ? '' : undefined}");
    expect(files('src/app/creators/[username]/CreatorContentTabs.tsx')).toContain('data-creator-grid');
    expect(files('src/components/templates/TemplateCatalogClient.tsx')).toContain('data-template-input-chip={value}');
  });

  it('gives each template the media it takes', () => {
    const template: MediaTemplate = {
      id: 'template-1',
      slug: 'two-inputs',
      name: 'Two inputs',
      description: 'A picture and a clip.',
      category: 'Product',
      videoUrl: null,
      thumbnailUrl: null,
      creatorUserId: 'creator-1',
      creator: null,
      inputSlots: [
        { key: 'first', kind: 'image', label: 'First picture', required: true },
        { key: 'clip', kind: 'video', label: 'Clip', required: true },
        { key: 'second', kind: 'image', label: 'Second picture', required: false },
      ],
      outputKind: 'video',
      status: 'active',
      moderationDisabledAt: null,
      useCount: 3,
      estimatedTotalCredits: 5,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    const { container } = render(<TemplateCard template={template} />);

    expect(container.querySelector('[data-template-inputs]')).toHaveAttribute('data-template-inputs', 'image video');
  });
});
