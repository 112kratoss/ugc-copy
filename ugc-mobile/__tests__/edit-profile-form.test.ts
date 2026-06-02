import { describe, expect, it } from 'vitest';

import { hasEditProfileChanges } from '../lib/edit-profile-form';

const savedProfileForm = {
  username: 'creator',
  displayName: 'Creator',
  bio: 'Making visual stories.',
  avatarUrl: 'https://example.com/avatar.jpg',
  coverUrl: 'https://example.com/cover.jpg',
};

describe('edit profile form state', () => {
  it('does not allow save when the form has no edits', () => {
    expect(hasEditProfileChanges({
      current: savedProfileForm,
      initial: savedProfileForm,
      hasAvatarDraft: false,
      hasCoverDraft: false,
    })).toBe(false);
  });

  it('allows save when text fields or picked media have changed', () => {
    expect(hasEditProfileChanges({
      current: { ...savedProfileForm, bio: 'Updated bio.' },
      initial: savedProfileForm,
      hasAvatarDraft: false,
      hasCoverDraft: false,
    })).toBe(true);

    expect(hasEditProfileChanges({
      current: savedProfileForm,
      initial: savedProfileForm,
      hasAvatarDraft: true,
      hasCoverDraft: false,
    })).toBe(true);
  });

  it('treats blank and nullish profile fields as the same unchanged value', () => {
    expect(hasEditProfileChanges({
      current: { ...savedProfileForm, bio: '', coverUrl: '' },
      initial: { ...savedProfileForm, bio: null, coverUrl: null },
      hasAvatarDraft: false,
      hasCoverDraft: false,
    })).toBe(false);
  });
});
