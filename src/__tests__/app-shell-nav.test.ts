import { describe, expect, it } from 'vitest';

import { getActiveAppNavItem, getAppShellTitle, isMinimalAppChromePath } from '@/app/components/app-shell-nav';

describe('app shell navigation', () => {
  it('keeps post composer routes in the Studio section', () => {
    expect(getActiveAppNavItem('/post/new')?.id).toBe('studio');
    expect(getActiveAppNavItem('/post/post-1/edit')?.id).toBe('studio');
  });

  it('keeps community routes in the Feed section', () => {
    expect(getActiveAppNavItem('/showcase')?.id).toBe('showcase');
    expect(getActiveAppNavItem('/creators/sassy23bh')?.id).toBe('showcase');
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
