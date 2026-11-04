import { describe, expect, it } from 'vitest';

import { claimRemixFreshStart } from '../lib/remix-opening';

describe('claimRemixFreshStart', () => {
  it('starts each opening of a remix session afresh once', () => {
    expect(claimRemixFreshStart('create-a', 'scope-1')).toBe(true);
    // A creator keyed afresh on the same route, or its effects run again: the session is its own.
    expect(claimRemixFreshStart('create-a', 'scope-1')).toBe(false);
    expect(claimRemixFreshStart('create-a', 'scope-1')).toBe(false);
  });

  it('starts another opening, or another session of the same opening, afresh too', () => {
    expect(claimRemixFreshStart('create-b', 'scope-1')).toBe(true);
    // The same route under another identity (a guest signing in) names another session.
    expect(claimRemixFreshStart('create-b', 'scope-2')).toBe(true);
    expect(claimRemixFreshStart('create-c', 'scope-1')).toBe(true);
  });

  it('forgets the oldest openings first, keeping the latest 64', () => {
    expect(claimRemixFreshStart('create-oldest', 'scope-1')).toBe(true);
    for (let index = 0; index < 64; index += 1) claimRemixFreshStart(`create-later-${index}`, 'scope-1');
    expect(claimRemixFreshStart('create-later-63', 'scope-1')).toBe(false);
    expect(claimRemixFreshStart('create-oldest', 'scope-1')).toBe(true);
  });
});
