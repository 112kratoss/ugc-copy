import { describe, expect, it } from 'vitest';

import { getAvatarInitial } from '../lib/profile-view-model';

describe('avatar initial', () => {
  it('uses the creator letter rather than the handle marker', () => {
    // Feed cards pass a handle, so a naive name[0] badged every avatar-less
    // creator with the same "@".
    expect(getAvatarInitial('@hello-athul')).toBe('H');
  });

  it('reads a plain display name', () => {
    expect(getAvatarInitial('Sassy23bh')).toBe('S');
  });

  it('ignores surrounding whitespace', () => {
    expect(getAvatarInitial('  luna  ')).toBe('L');
  });

  it('keeps letters from non-Latin scripts instead of falling back', () => {
    expect(getAvatarInitial('@अथुल')).toBe('अ');
  });

  it('keeps a leading digit when a handle starts with one', () => {
    expect(getAvatarInitial('@2cool')).toBe('2');
  });

  it('falls back when there is nothing to show', () => {
    expect(getAvatarInitial('')).toBe('C');
    expect(getAvatarInitial('@@@')).toBe('C');
  });
});
