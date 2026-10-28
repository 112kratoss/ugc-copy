import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CREATE_MENU_ITEMS,
  CREATE_MENU_SUBTITLE,
  CREATE_MENU_TITLE,
  getCreateMenuHref,
} from '@/components/app-shell-nav';

// Read as text: the root suite cannot load a ugc-mobile module on CI, whose
// web job installs no ugc-mobile dependencies for its tsconfig to resolve.
const mobileFile = (relative: string) => readFileSync(path.join(process.cwd(), 'ugc-mobile', relative), 'utf8');

describe('the Create menu', () => {
  it("offers the app's two choices in the app's words", () => {
    const viewModel = mobileFile('lib/create-menu-view-model.ts');
    const appItems = [...viewModel.matchAll(/id: '(\w+)',\s*label: '([^']+)',\s*body: '([^']+)'/g)]
      .map(([, id, label, body]) => ({ id, label, body }));

    expect(appItems).toHaveLength(2);
    expect(CREATE_MENU_ITEMS).toEqual(appItems);
  });

  it("carries the app sheet's heading", () => {
    const sheet = mobileFile('components/magic-create-menu.tsx');

    expect(sheet).toContain(CREATE_MENU_TITLE);
    expect(sheet).toContain(CREATE_MENU_SUBTITLE);
  });

  it('opens the creators hub for Create, from any page', () => {
    expect(getCreateMenuHref('create', '/')).toBe('/create');
    expect(getCreateMenuHref('create', '/post/new')).toBe('/create');
  });

  it("starts a post with a Back to the page it was started on, where the composer knows that page", () => {
    const composer = (pathname: string) => {
      const url = new URL(getCreateMenuHref('post', pathname), 'https://magicbooklet.test');
      return { path: url.pathname, from: url.searchParams.get('from'), returnTo: url.searchParams.get('returnTo') };
    };

    // The source alone: the composer takes its Back from it (Home's `/`, the profile's
    // posts, Studio's posts view, and so on), so the menu sends no address of its own.
    expect(composer('/')).toEqual({ path: '/post/new', from: 'home', returnTo: null });
    // The server sees the signed-in Home at its rewrite target.
    expect(composer('/home')).toEqual({ path: '/post/new', from: 'home', returnTo: null });
    expect(composer('/showcase')).toEqual({ path: '/post/new', from: 'community', returnTo: null });
    expect(composer('/profile')).toEqual({ path: '/post/new', from: 'profile', returnTo: null });
    expect(composer('/profile/edit')).toEqual({ path: '/post/new', from: 'profile', returnTo: null });
    expect(composer('/marketplace')).toEqual({ path: '/post/new', from: 'marketplace', returnTo: null });
    expect(composer('/marketplace/sell')).toEqual({ path: '/post/new', from: 'seller', returnTo: null });
    expect(composer('/creations')).toEqual({ path: '/post/new', from: 'creations', returnTo: null });
  });

  it("leaves the composer's own default on any other page", () => {
    // A post page, a creator, Alerts, the shell's neutral pathname before hydration.
    for (const pathname of ['/showcase/post-1', '/creators/someone', '/notifications', '/create-image', '']) {
      expect(getCreateMenuHref('post', pathname)).toBe('/post/new');
    }
  });
});
