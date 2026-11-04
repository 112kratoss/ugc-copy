import { describe, expect, it, vi } from 'vitest';

import { buildProfileSaveBody, validateProfileUpdate, type EditableCreatorProfile } from '@/lib/profile';

const PUBLIC = 'https://project.supabase.co/storage/v1/object/public/profiles/user-1/';

const form: EditableCreatorProfile = {
  id: 'user-1',
  username: 'luna',
  displayName: 'Luna Dreams',
  bio: 'Painting with light.',
  avatarUrl: `${PUBLIC}avatar-a.normalized.0123456789abcdef.webp`,
  coverUrl: `${PUBLIC}cover-a.normalized.0123456789abcdef.webp`,
  websiteUrl: 'https://luna.example',
  twitterHandle: 'luna',
  instagramHandle: '',
  tiktokHandle: '',
  location: 'Goa',
  credits: 10,
};

// The web form is opened once and never reloaded: a photo URL it read when it
// opened can be one another device has replaced since. Like the app's
// `buildProfileUpdateBody`, a save sends a photo only when it uploaded one.
describe('buildProfileSaveBody', () => {
  it('sends the profile text and no photo the save did not upload', () => {
    expect(buildProfileSaveBody(form)).toEqual({
      username: 'luna',
      displayName: 'Luna Dreams',
      bio: 'Painting with light.',
      websiteUrl: 'https://luna.example',
      twitterHandle: 'luna',
      instagramHandle: '',
      tiktokHandle: '',
      location: 'Goa',
    });
  });

  it('sends the photo this save uploaded, and only that one', () => {
    const body = buildProfileSaveBody(form, { avatarUrl: `${PUBLIC}avatar-b.png` });

    expect(body).toMatchObject({ avatarUrl: `${PUBLIC}avatar-b.png` });
    expect(body).not.toHaveProperty('coverUrl');
  });

  // A new account's editor shows its sign-in provider's picture while no
  // photo is stored (load-owner-profile): saving puts it on the public profile.
  describe('the sign-in provider\'s picture', () => {
    const google = 'https://lh3.googleusercontent.com/a/ACg8ocL-photo=s96-c';
    const fresh = { ...form, avatarUrl: google, authProviderAvatarUrl: google };

    it('goes in the save while no photo is stored', () => {
      expect(buildProfileSaveBody(fresh)).toMatchObject({ avatarUrl: google });
      expect(buildProfileSaveBody(fresh)).not.toHaveProperty('coverUrl');
    });

    it('gives way to a photo the save uploaded', () => {
      expect(buildProfileSaveBody(fresh, { avatarUrl: `${PUBLIC}avatar-b.png` })).toMatchObject({ avatarUrl: `${PUBLIC}avatar-b.png` });
    });

    it('stays out once the form shows another photo', () => {
      expect(buildProfileSaveBody({ ...fresh, avatarUrl: `${PUBLIC}avatar-a.normalized.0123456789abcdef.webp` })).not.toHaveProperty('avatarUrl');
    });

    it('passes the server\'s media host check in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      try {
        expect(validateProfileUpdate({ username: 'luna', avatarUrl: google })).toMatchObject({
          data: { avatarUrl: google },
          fieldErrors: {},
        });
        // The check is live: another host is refused.
        expect(validateProfileUpdate({ username: 'luna', avatarUrl: 'https://images.example.com/a.png' }).fieldErrors)
          .toHaveProperty('avatarUrl');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('sends both photos when the save uploaded both', () => {
    expect(buildProfileSaveBody(form, { avatarUrl: `${PUBLIC}avatar-b.png`, coverUrl: `${PUBLIC}cover-b.png` }))
      .toMatchObject({ avatarUrl: `${PUBLIC}avatar-b.png`, coverUrl: `${PUBLIC}cover-b.png` });
  });
});
