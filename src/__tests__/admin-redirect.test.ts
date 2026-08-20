import { describe, expect, it } from 'vitest';

import { resolveSafeAdminRedirect } from '@/lib/admin-redirect';

const ORIGIN = 'https://magicbooklet.com';

describe('admin login redirect boundary', () => {
  it('keeps an ordinary admin path, query, and fragment', () => {
    expect(resolveSafeAdminRedirect('/admin/users?filter=open#latest', ORIGIN))
      .toBe('/admin/users?filter=open#latest');
  });

  it('inspects and rejects the value produced by the sixth recursive decode', () => {
    expect(resolveSafeAdminRedirect('/admin?next=%25252525250A', ORIGIN)).toBe('/admin');
  });

  it.each([
    'https://evil.example/admin',
    'https://operator:secret@magicbooklet.com/admin',
    '//evil.example/admin',
    '///operator:secret@evil.example/admin',
    '/\\evil.example/admin',
    '/%5cevil.example/admin',
    '/%255cevil.example/admin',
    '/admin%2f..%2foutside',
    '/admin%252f..%252foutside',
    '/admin\n/evil',
    '/admin%0a/evil',
    '/admin%250a/evil',
    '/profile',
  ])('resolves unsafe continuation %s to the console root', (value) => {
    expect(resolveSafeAdminRedirect(value, ORIGIN)).toBe('/admin');
  });
});
