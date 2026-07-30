import { describe, expect, it } from 'vitest';

import { getActiveAppNavItem, getAppShellTitle, isMinimalAppChromePath } from '@/app/components/app-shell-nav';

describe('app shell navigation', () => {
  it('keeps post composer routes in the Studio section', () => {
    expect(getActiveAppNavItem('/post/new')?.id).toBe('studio');
    expect(getActiveAppNavItem('/post/post-1/edit')?.id).toBe('studio');
  });

  it('keeps the community feed itself in the Showcase section', () => {
    expect(getActiveAppNavItem('/showcase')?.id).toBe('showcase');
    expect(getAppShellTitle('/showcase')).toBe('Showcase');
    expect(getActiveAppNavItem('/creators')?.id).toBe('showcase');
  });

  it('never mistakes a filtered feed for a post', () => {
    // usePathname() strips query and hash, so the shell only ever sees the bare
    // pathname. These guard the detail predicate itself: a filtered feed must
    // not slip into the post branch and start reporting itself as "Post".
    expect(getAppShellTitle('/showcase?category=video')).not.toBe('Post');
    expect(getAppShellTitle('/showcase#top')).not.toBe('Post');
  });

  it('treats a post as its own surface rather than part of Showcase', () => {
    // Reachable from Home, /feed, Marketplace, Studio or a shared link, so
    // highlighting Showcase would claim a section the viewer is not in.
    expect(getActiveAppNavItem('/showcase/post-1')).toBeNull();
    expect(getAppShellTitle('/showcase/post-1')).toBe('Post');
  });

  it('treats a creator profile as its own surface', () => {
    expect(getActiveAppNavItem('/creators/sassy23bh')).toBeNull();
    expect(getAppShellTitle('/creators/sassy23bh')).toBe('Creator');
  });

  it('keeps template discovery and runs in the Create section', () => {
    expect(getActiveAppNavItem('/templates')?.id).toBe('create');
    expect(getActiveAppNavItem('/templates/ghost-rider')?.id).toBe('create');
    expect(getActiveAppNavItem('/template-runs/run-1')?.id).toBe('create');
    expect(getAppShellTitle('/templates')).toBe('Templates');
    expect(getAppShellTitle('/templates/new')).toBe('Create Template');
    expect(getAppShellTitle('/template-runs/run-1')).toBe('Create From Template');
  });

  it('uses the composer title for new post routes', () => {
    expect(getAppShellTitle('/post/new')).toBe('Share Post');
  });

  it('keeps authentication and referral landing routes focused outside the workspace shell', () => {
    expect(isMinimalAppChromePath('/login')).toBe(true);
    expect(isMinimalAppChromePath('/auth/reset-password')).toBe(true);
    expect(isMinimalAppChromePath('/r/friend123')).toBe(true);
    expect(isMinimalAppChromePath('/child-safety')).toBe(true);
    expect(isMinimalAppChromePath('/showcase')).toBe(false);
  });
});
