import { describe, expect, it } from 'vitest';

import { resolveCreatorOwnership } from '@/lib/creator-ownership';

// Whether a page's creator is the one looking, as the post page and the creator page both decide it
// from the first frame: the post page's Owner tools, Remix and recipe, and the creator page's recipe
// chips, which read "Free recipe" to the creator on their own page until their session was checked
// (sweep of 2026-11-17).
describe('resolveCreatorOwnership', () => {
  const base = { creatorId: 'user-1', viewerUserId: null, viewerCheck: 'checking', checkedCookieUserId: null } as const;

  it('names the creator once the check has named them, whatever the check says since', () => {
    for (const viewerCheck of ['signed-in', 'checking', 'visitor', 'unread'] as const) {
      expect(resolveCreatorOwnership({ ...base, viewerUserId: 'user-1', viewerCheck })).toBe('owner');
    }
  });

  it('is anyone else for another account, and on a page with no creator account', () => {
    expect(resolveCreatorOwnership({ ...base, viewerUserId: 'user-2', viewerCheck: 'signed-in' })).toBe('other');
    expect(resolveCreatorOwnership({ ...base, creatorId: null, checkedCookieUserId: 'user-1' })).toBe('other');
    expect(resolveCreatorOwnership({ ...base, creatorId: null, viewerCheck: 'unread' })).toBe('other');
  });

  it("is unread in the server's HTML and the render that hydrates it, for a creator a style rule can name", () => {
    expect(resolveCreatorOwnership({ ...base, viewerCheck: 'unread' })).toBe('unread');
    expect(resolveCreatorOwnership({ ...base, creatorId: 'e2e-recipe-page-creator', viewerCheck: 'unread' })).toBe('unread');
    // A rule cannot name it as it stands: drawn as for anyone else until the check ends.
    expect(resolveCreatorOwnership({ ...base, creatorId: 'user"] *{display:none} [x="', viewerCheck: 'unread' })).toBe('other');
  });

  it('is the creator, being checked, while the cookie being checked names them, its deadline passed or not', () => {
    expect(resolveCreatorOwnership({ ...base, checkedCookieUserId: 'user-1' })).toBe('owner-checking');
    // Past the deadline the reader's own parts fall back (`visitor`); the creator's wait for the answer.
    expect(resolveCreatorOwnership({ ...base, viewerCheck: 'visitor', checkedCookieUserId: 'user-1' })).toBe('owner-checking');
  });

  it('is anyone else while a cookie naming someone else is checked, and with none being checked', () => {
    expect(resolveCreatorOwnership({ ...base, checkedCookieUserId: 'user-2' })).toBe('other');
    expect(resolveCreatorOwnership({ ...base, viewerCheck: 'visitor' })).toBe('other');
  });
});
