import { describe, expect, it } from 'vitest';

import reservedHandlesContract from '../../contracts/reserved-handles-v1.json';

import { ApiError } from '../lib/api-client';
import {
  EMPTY_EDIT_PROFILE_FORM,
  EditProfileValidationError,
  PROFILE_PLACEHOLDER_USERNAME_ERROR,
  RESERVED_PROFILE_USERNAMES,
  RESERVED_PROFILE_USERNAME_ERROR,
  buildIdentityClaimBody,
  buildProfileUpdateBody,
  editProfileFormFromProfile,
  hasEditProfileChanges,
  isClaimedProfileUsername,
  isProfileFieldVerdict,
  profilePhotoCropAspect,
  readLocalUsernameRejection,
  readProfileSaveRefusal,
  shouldCheckUsernameAvailability,
  validateProfileField,
  validateProfileForm,
  type EditProfileFormValues,
} from '../lib/edit-profile-form';
import type { ProfileResponse } from '../lib/types';

const savedProfileForm = {
  username: 'creator',
  displayName: 'Creator',
  bio: 'Making visual stories.',
  avatarUrl: 'https://example.com/avatar.jpg',
  coverUrl: 'https://example.com/cover.jpg',
};

const savedForm: EditProfileFormValues = {
  ...EMPTY_EDIT_PROFILE_FORM,
  username: 'luna-dreams',
  displayName: 'Luna',
  bio: 'Worlds.',
  avatarUrl: 'https://cdn.example/avatar.webp',
  coverUrl: 'https://cdn.example/cover.webp',
  websiteUrl: 'https://luna.example',
  location: 'Lisbon',
  twitterHandle: 'luna',
  instagramHandle: 'luna.dreams',
  tiktokHandle: 'lunadreams',
};

function profile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: 'user-1',
    username: 'luna-dreams',
    suggestedUsername: 'creator-1a2b3c4d',
    displayName: 'Luna',
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: 0,
    ...overrides,
  };
}

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

  it('counts an edit to a link or the location as a change', () => {
    for (const field of ['websiteUrl', 'location', 'twitterHandle', 'instagramHandle', 'tiktokHandle'] as const) {
      expect(hasEditProfileChanges({
        current: { ...savedForm, [field]: `${savedForm[field]}x` },
        initial: savedForm,
        hasAvatarDraft: false,
        hasCoverDraft: false,
      }), field).toBe(true);
    }
    expect(hasEditProfileChanges({
      current: { ...savedForm, websiteUrl: '' },
      initial: { ...savedForm, websiteUrl: null },
      hasAvatarDraft: false,
      hasCoverDraft: false,
    })).toBe(false);
  });
});

describe('what a save sends', () => {
  it('sends the handle and only the fields edited since the form opened', () => {
    // A partial PATCH keeps every key it is not sent, so a link changed on the
    // web while this form was open survives a bio edit made here.
    expect(buildProfileUpdateBody({
      current: { ...savedForm, bio: 'New worlds.' },
      initial: savedForm,
    })).toEqual({ username: 'luna-dreams', bio: 'New worlds.' });
  });

  it('sends the edited links and location, trimmed, and clears an emptied one with null', () => {
    expect(buildProfileUpdateBody({
      current: { ...savedForm, websiteUrl: '  https://new.example  ', location: '', twitterHandle: '@luna_x' },
      initial: savedForm,
    })).toEqual({
      username: 'luna-dreams',
      websiteUrl: 'https://new.example',
      location: null,
      twitterHandle: '@luna_x',
    });
  });

  it('never sends a null display name, which the server refuses', () => {
    expect(buildProfileUpdateBody({ current: { ...savedForm, displayName: '  ' }, initial: savedForm }))
      .toEqual({ username: 'luna-dreams' });
  });

  it('sends a photo only when one was uploaded for this save', () => {
    expect(buildProfileUpdateBody({ current: savedForm, initial: savedForm }))
      .toEqual({ username: 'luna-dreams' });
    expect(buildProfileUpdateBody({
      current: savedForm,
      initial: savedForm,
      avatarUrl: 'https://cdn.example/avatar-new.webp',
      coverUrl: null,
    })).toEqual({ username: 'luna-dreams', avatarUrl: 'https://cdn.example/avatar-new.webp' });
  });

  it('normalises the handle it sends, as the field does', () => {
    expect(buildProfileUpdateBody({ current: { ...savedForm, username: '@Luna-Dreams ' }, initial: savedForm }).username)
      .toBe('luna-dreams');
  });

  it('claims a name in onboarding with the two fields its step holds, and nothing else', () => {
    expect(buildIdentityClaimBody('luna-dreams', 'Luna')).toEqual({ username: 'luna-dreams', displayName: 'Luna' });
  });
});

describe('the form a profile opens as', () => {
  it('opens a placeholder handle as an empty field, as onboarding does', () => {
    expect(editProfileFormFromProfile(profile({ username: 'creator-1a2b3c4d' })).username).toBe('');
    expect(editProfileFormFromProfile(profile({ username: null })).username).toBe('');
    expect(editProfileFormFromProfile(profile()).username).toBe('luna-dreams');
  });

  it('carries the links and location the profile holds', () => {
    expect(editProfileFormFromProfile(profile({
      websiteUrl: 'https://luna.example',
      location: 'Lisbon',
      twitterHandle: 'luna',
      instagramHandle: 'luna.dreams',
      tiktokHandle: null,
    }))).toMatchObject({
      websiteUrl: 'https://luna.example',
      location: 'Lisbon',
      twitterHandle: 'luna',
      instagramHandle: 'luna.dreams',
      tiktokHandle: '',
    });
  });
});

describe('handles', () => {
  it('holds the reserved list to the contract the server reads', () => {
    expect([...RESERVED_PROFILE_USERNAMES]).toEqual(reservedHandlesContract.reserved);
  });

  it('calls a handle claimed only when it is valid and not the signup placeholder', () => {
    expect(isClaimedProfileUsername('luna-dreams')).toBe(true);
    expect(isClaimedProfileUsername('@Luna-Dreams')).toBe(true);
    expect(isClaimedProfileUsername('creator-1a2b3c4d')).toBe(false);
    expect(isClaimedProfileUsername('luna_dreams')).toBe(false);
    expect(isClaimedProfileUsername('')).toBe(false);
    expect(isClaimedProfileUsername(null)).toBe(false);
  });

  it('refuses the placeholder with onboarding’s words, before any request', () => {
    expect(validateProfileField('username', 'creator-1a2b3c4d')).toBe(PROFILE_PLACEHOLDER_USERNAME_ERROR);
    expect(PROFILE_PLACEHOLDER_USERNAME_ERROR).toBe('Use 3–24 lowercase letters, numbers, or hyphens for your handle.');
    // Refused even when it is the handle the account holds: the server refuses it on every save.
    expect(validateProfileField('username', 'creator-1a2b3c4d', { savedUsername: 'creator-1a2b3c4d' }))
      .toBe(PROFILE_PLACEHOLDER_USERNAME_ERROR);
  });

  it('refuses a reserved handle, unless the account already holds it', () => {
    expect(validateProfileField('username', 'Admin')).toBe(RESERVED_PROFILE_USERNAME_ERROR);
    expect(RESERVED_PROFILE_USERNAME_ERROR).toBe('That handle is reserved.');
    expect(validateProfileField('username', 'admin', { savedUsername: 'admin' })).toBeUndefined();
    expect(validateProfileField('username', 'admin-2')).toBeUndefined();
  });

  it('answers the placeholder and the reserved list without asking the server', () => {
    expect(readLocalUsernameRejection('support', 'luna-dreams')).toBe(RESERVED_PROFILE_USERNAME_ERROR);
    expect(readLocalUsernameRejection('creator-1a2b3c4d', 'luna-dreams')).toBe(PROFILE_PLACEHOLDER_USERNAME_ERROR);
    expect(readLocalUsernameRejection('ab', 'luna-dreams')).toBeNull();
    const saved = { savedUsername: 'luna-dreams', displayName: 'Luna' };
    expect(shouldCheckUsernameAvailability({ value: 'support', ...saved })).toBe(false);
    expect(shouldCheckUsernameAvailability({ value: 'creator-1a2b3c4d', ...saved })).toBe(false);
    expect(shouldCheckUsernameAvailability({ value: 'new-name', ...saved })).toBe(true);
  });

  it('stops the save on an unclaimed account until a handle is chosen', () => {
    const form = editProfileFormFromProfile(profile({ username: 'creator-1a2b3c4d', bio: 'Old bio' }));
    expect(validateProfileForm({ ...form, bio: 'New bio' }, { savedUsername: 'creator-1a2b3c4d' }))
      .toEqual({ username: 'Choose a username for your profile.' });
  });
});

describe('links and location', () => {
  it('asks for a scheme on the website, which every link the server keeps has', () => {
    expect(validateProfileField('websiteUrl', 'luna.example')).toBe('Website URL must start with http:// or https://.');
    expect(validateProfileField('websiteUrl', ' https://luna.example ')).toBeUndefined();
    expect(validateProfileField('websiteUrl', 'HTTP://luna.example')).toBeUndefined();
    expect(validateProfileField('websiteUrl', '')).toBeUndefined();
    expect(validateProfileField('websiteUrl', `https://${'a'.repeat(2048)}`)).toBe('Website URL must be 2,048 characters or fewer.');
  });

  it('caps the location at the server’s 80 characters', () => {
    expect(validateProfileField('location', 'a'.repeat(80))).toBeUndefined();
    expect(validateProfileField('location', 'a'.repeat(81))).toBe('Location must be 80 characters or fewer.');
  });

  it('leaves the social handles to the server, which takes a handle or a profile link', () => {
    expect(validateProfileField('twitterHandle', 'https://x.com/luna')).toBeUndefined();
    expect(validateProfileField('instagramHandle', '@luna.dreams')).toBeUndefined();
    expect(validateProfileForm({ ...savedForm, twitterHandle: 'not a handle' })).toEqual({});
  });

  it('treats only a 400 or a 409 as the server’s verdict on the fields', () => {
    expect(isProfileFieldVerdict(new ApiError('Please fix the highlighted fields.', 400))).toBe(true);
    expect(isProfileFieldVerdict(new ApiError('That username is already taken.', 409))).toBe(true);
    expect(isProfileFieldVerdict(new ApiError('Too many requests', 429))).toBe(false);
    expect(isProfileFieldVerdict(new Error('Network request failed'))).toBe(false);
  });
});

describe('a refused save', () => {
  it('puts a verdict on a field under that field, with nothing for the block', () => {
    expect(readProfileSaveRefusal(new ApiError('That username is already taken.', 409, {
      fieldErrors: { username: 'That username is already taken.' },
    }))).toEqual({
      fieldErrors: { username: 'That username is already taken.' },
      firstField: 'username',
      message: null,
    });
  });

  it('reads a 409 without field errors as a verdict on the handle', () => {
    expect(readProfileSaveRefusal(new ApiError('That username is already taken.', 409))).toMatchObject({
      fieldErrors: { username: 'That username is already taken.' },
      message: null,
    });
  });

  it('names the first refused field down the form, whatever order the server lists them in', () => {
    const refusal = readProfileSaveRefusal(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { tiktokHandle: 'Enter your TikTok username or profile link.', websiteUrl: 'Enter a website.', bio: 'Too long.' },
    }));
    expect(refusal.firstField).toBe('bio');
    expect(Object.keys(refusal.fieldErrors).sort()).toEqual(['bio', 'tiktokHandle', 'websiteUrl']);
    expect(refusal.message).toBeNull();
  });

  it('heads the form with the photos', () => {
    expect(readProfileSaveRefusal(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { displayName: 'Add a display name.', avatarUrl: 'Upload the display photo again.' },
    })).firstField).toBe('avatarUrl');
  });

  it('keeps the form’s own refusal under its fields', () => {
    const fieldErrors = validateProfileForm({ username: 'ab', displayName: '', bio: '' });
    expect(readProfileSaveRefusal(new EditProfileValidationError(fieldErrors))).toEqual({
      fieldErrors,
      firstField: 'displayName',
      message: null,
    });
  });

  it('gives the block a refusal that names no field the form draws', () => {
    expect(readProfileSaveRefusal(new Error('Network request failed'))).toEqual({
      fieldErrors: {},
      firstField: null,
      message: 'Network request failed',
    });
    // A verdict on a field the form does not draw would be said nowhere.
    expect(readProfileSaveRefusal(new ApiError('Please fix the highlighted fields.', 400, {
      fieldErrors: { email: 'Use another email.' },
    }))).toMatchObject({ fieldErrors: {}, firstField: null, message: 'Please fix the highlighted fields.' });
    expect(readProfileSaveRefusal('refused').message).toBe('Profile could not be saved.');
  });
});

describe('picking a profile photo', () => {
  it('crops the avatar square on both platforms', () => {
    expect(profilePhotoCropAspect('avatar', 'ios')).toEqual([1, 1]);
    expect(profilePhotoCropAspect('avatar', 'android')).toEqual([1, 1]);
  });

  it('takes the cover whole on iOS, whose system crop is always square, and keeps Android’s 16:9 crop', () => {
    expect(profilePhotoCropAspect('cover', 'ios')).toBeNull();
    expect(profilePhotoCropAspect('cover', 'android')).toEqual([16, 9]);
  });
});
