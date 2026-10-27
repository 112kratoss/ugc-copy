import { UNDERSCORE_NOT_FOUND_ROUTE } from 'next/dist/shared/lib/entry-constants';
import { NOT_FOUND_SEGMENT_KEY } from 'next/dist/shared/lib/segment';
import { describe, expect, it } from 'vitest';

import {
  getActiveAppNavItem,
  getAppShellTitle,
  isMinimalAppChromePath,
  isNotFoundRouteSegment,
} from '@/components/app-shell-nav';

describe('app shell navigation', () => {
  it('keeps post composer routes in the Studio section', () => {
    expect(getActiveAppNavItem('/post/new')?.id).toBe('studio');
    expect(getActiveAppNavItem('/post/post-1/edit')?.id).toBe('studio');
  });

  it('keeps the community feed itself in the Explore section', () => {
    expect(getActiveAppNavItem('/showcase')?.id).toBe('showcase');
    expect(getActiveAppNavItem('/creators')?.id).toBe('showcase');
  });

  it('names no page in the top bar that opens with a heading of its own', () => {
    // The bar said "Studio" over a page headed "Studio", and so on.
    for (const pathname of [
      '/showcase',
      '/creations',
      '/create',
      '/search',
      '/marketplace',
      '/marketplace/sell',
      '/notifications',
      '/invite',
      '/credits',
      '/pricing',
      '/models',
      '/models/kling-3-0',
      '/profile',
      '/profile/edit',
      '/post/new',
      '/post/post-1/edit',
    ]) {
      expect(getAppShellTitle(pathname), pathname).toBeNull();
    }
  });

  it('names the pages that have no heading of their own', () => {
    expect(getAppShellTitle('/')).toBe('Home');
    expect(getAppShellTitle('/create-image')).toBe('Create');
    expect(getAppShellTitle('/create-workflow')).toBe('Workflow Canvas');
    expect(getAppShellTitle('/templates')).toBe('Templates');
  });

  it('no longer has a separate Feed section: /feed sends its visitors Home', () => {
    expect(getActiveAppNavItem('/feed')).toBeNull();
  });

  it('never mistakes a filtered feed for a post', () => {
    // usePathname() strips query and hash, so the shell only ever sees the bare
    // pathname. These guard the detail predicate itself: a filtered feed must
    // not slip into the post branch and start reporting itself as "Post".
    expect(getAppShellTitle('/showcase?category=video')).not.toBe('Post');
    expect(getAppShellTitle('/showcase#top')).not.toBe('Post');
  });

  it('treats a post as its own surface rather than part of Explore', () => {
    // Reachable from Home, /feed, Marketplace, Studio or a shared link, so
    // highlighting Showcase would claim a section the viewer is not in.
    expect(getActiveAppNavItem('/showcase/post-1')).toBeNull();
    expect(getAppShellTitle('/showcase/post-1')).toBe('Post');
  });

  it('treats a creator profile as its own surface', () => {
    expect(getActiveAppNavItem('/creators/sassy23bh')).toBeNull();
    expect(getAppShellTitle('/creators/sassy23bh')).toBe('Creator');
  });

  it('gives public search its own entry', () => {
    expect(getActiveAppNavItem('/search')?.id).toBe('search');
    // A query string never reaches usePathname, but the bare path must not be
    // claimed by any neighbouring section.
    expect(getActiveAppNavItem('/showcase')?.id).toBe('showcase');
  });

  it('keeps template discovery and runs in the Create section', () => {
    expect(getActiveAppNavItem('/templates')?.id).toBe('create');
    expect(getActiveAppNavItem('/templates/ghost-rider')?.id).toBe('create');
    expect(getActiveAppNavItem('/template-runs/run-1')?.id).toBe('create');
    expect(getAppShellTitle('/templates')).toBe('Templates');
    expect(getAppShellTitle('/templates/new')).toBe('Create Template');
    expect(getAppShellTitle('/template-runs/run-1')).toBe('Create From Template');
  });

  it('keeps authentication and referral landing routes focused outside the workspace shell', () => {
    expect(isMinimalAppChromePath('/login')).toBe(true);
    expect(isMinimalAppChromePath('/auth/reset-password')).toBe(true);
    expect(isMinimalAppChromePath('/r/friend123')).toBe(true);
    expect(isMinimalAppChromePath('/child-safety')).toBe(true);
    expect(isMinimalAppChromePath('/showcase')).toBe(false);
  });

  it("recognises Next's not-found route segment under either bundler", () => {
    // From Next itself, so an upgrade that respells either fails here: CI's
    // E2E runs the dev server, which never hydrates the build-time 404.
    // Turbopack's tree carries the segment key; webpack's loader writes the
    // route without its slash.
    expect(isNotFoundRouteSegment(NOT_FOUND_SEGMENT_KEY)).toBe(true);
    expect(isNotFoundRouteSegment(UNDERSCORE_NOT_FOUND_ROUTE.slice(1))).toBe(true);
    expect(isNotFoundRouteSegment(null)).toBe(false);
    expect(isNotFoundRouteSegment('pricing')).toBe(false);
  });
});
