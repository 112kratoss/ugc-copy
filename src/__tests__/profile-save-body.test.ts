import { describe, expect, it } from 'vitest';

import { buildProfileSaveBody, type EditableCreatorProfile } from '@/lib/profile';

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

  it('sends both photos when the save uploaded both', () => {
    expect(buildProfileSaveBody(form, { avatarUrl: `${PUBLIC}avatar-b.png`, coverUrl: `${PUBLIC}cover-b.png` }))
      .toMatchObject({ avatarUrl: `${PUBLIC}avatar-b.png`, coverUrl: `${PUBLIC}cover-b.png` });
  });
});
