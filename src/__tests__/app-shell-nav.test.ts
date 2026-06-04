import { describe, expect, it } from 'vitest';

import { getActiveAppNavItem, getAppShellTitle } from '@/app/components/app-shell-nav';

describe('app shell navigation', () => {
  it('keeps post composer routes in the Studio section', () => {
    expect(getActiveAppNavItem('/post/new')?.id).toBe('studio');
    expect(getActiveAppNavItem('/post/post-1/edit')?.id).toBe('studio');
  });

  it('keeps community routes in the Feed section', () => {
    expect(getActiveAppNavItem('/showcase')?.id).toBe('showcase');
    expect(getActiveAppNavItem('/creators/sassy23bh')?.id).toBe('showcase');
  });

  it('uses the composer title for new post routes', () => {
    expect(getAppShellTitle('/post/new')).toBe('Share Post');
  });
});
