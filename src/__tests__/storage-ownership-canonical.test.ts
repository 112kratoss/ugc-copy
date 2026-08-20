import { describe, expect, it } from 'vitest';

import {
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

describe('canonical privileged storage paths', () => {
  it('returns one decoded canonical representation for an ordinary owned path', () => {
    expect(parseCanonicalStorageLocation(
      'uploads/user-1/reference%20image.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toEqual({
      bucket: 'uploads',
      filePath: 'user-1/reference image.png',
    });
  });

  it.each([
    'user-1/../other/private.png',
    'user-1/%2e%2e/other/private.png',
    'user-1/%252e%252e/other/private.png',
    'user-1%2fother/private.png',
    'user-1%252fother/private.png',
    'user-1/%5cother/private.png',
    'user-1\\other/private.png',
    'user-1//private.png',
    '/user-1/private.png',
  ])('rejects non-canonical object path %s', (value) => {
    expect(parseCanonicalStorageObjectPath(value, { ownerUserId: 'user-1' })).toBeNull();
  });

  it('rejects bucket or owner changes before a privileged storage call', () => {
    expect(parseCanonicalStorageLocation(
      'uploads/user-2/private.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toBeNull();
    expect(parseCanonicalStorageLocation(
      'uploads%2fgenerated_images/user-1/private.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toBeNull();
    expect(parseCanonicalStorageLocation(
      'generated_images/user-1/private.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toBeNull();
    expect(parseCanonicalStorageLocation(
      'uploads/%75ser-1/private.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toBeNull();
    expect(parseCanonicalStorageLocation(
      'uploads/%2575ser-1/private.png',
      { allowedBuckets: ['uploads'], ownerUserId: 'user-1' },
    )).toBeNull();
  });

  it('rejects encoded separators in full Supabase Storage URLs before decoding them', () => {
    expect(getUserOwnedStoredMediaLocation(
      'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1%252fother/private.png?token=x',
      'user-1',
    )).toBeNull();
    expect(getUserOwnedStoredMediaLocation(
      'https://project.supabase.co/storage/v1/object/public/generated_images/user-1/photo.png',
      'user-1',
    )).toEqual({ bucket: 'generated_images', filePath: 'user-1/photo.png' });
  });

  it.each([
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/../other/private.png?token=x',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/%2e%2e/other/private.png?token=x',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/%252e%252e/other/private.png?token=x',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1\\other/private.png?token=x',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/%5cother/private.png?token=x',
    'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/%255cother/private.png?token=x',
  ])('rejects URL path normalization tricks without losing their raw representation: %s', (value) => {
    expect(getUserOwnedStoredMediaLocation(value, 'user-1')).toBeNull();
  });
});
