import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';

import {
  signIdentityAdmission,
  verifyIdentityAdmission,
} from '@/lib/identity-admission-assertion';

const SECRET = 'identity-admission-test-secret-at-least-32-characters';
const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'creator@example.test',
  phone: undefined,
  is_anonymous: false,
  app_metadata: { provider: 'email' },
  user_metadata: {
    full_name: 'Creator',
    avatar_url: 'https://images.example.test/avatar.png',
    ignored_large_field: 'not-forwarded',
  },
  created_at: '2026-08-22T00:00:00.000Z',
};

describe('identity admission assertion', () => {
  it('verifies a short-lived assertion bound to token, method, and path', async () => {
    const assertion = await signIdentityAdmission({
      authorization: 'Bearer verified-token',
      method: 'POST',
      pathname: '/api/generate',
      state: 'active',
      user: USER,
      now: 10_000,
      secret: SECRET,
    });
    expect(assertion).toBeTruthy();

    await expect(verifyIdentityAdmission(assertion!, {
      authorization: 'Bearer verified-token',
      method: 'POST',
      pathname: '/api/generate',
      now: 20_000,
      secret: SECRET,
    })).resolves.toMatchObject({
      state: 'active',
      user: {
        id: USER.id,
        email: USER.email,
        user_metadata: {
          full_name: 'Creator',
          avatar_url: 'https://images.example.test/avatar.png',
        },
      },
    });
  });

  it('rejects replay on another token, method, path, or expired request', async () => {
    const assertion = await signIdentityAdmission({
      authorization: 'Bearer verified-token',
      method: 'GET',
      pathname: '/api/showcase/feed',
      state: 'active',
      user: USER,
      now: 10_000,
      secret: SECRET,
    });
    const common = { now: 20_000, secret: SECRET };

    for (const binding of [
      { authorization: 'Bearer another-token', method: 'GET', pathname: '/api/showcase/feed' },
      { authorization: 'Bearer verified-token', method: 'POST', pathname: '/api/showcase/feed' },
      { authorization: 'Bearer verified-token', method: 'GET', pathname: '/api/showcase/posts/post-1' },
      { authorization: 'Bearer verified-token', method: 'GET', pathname: '/api/showcase/feed', now: 50_001 },
    ]) {
      await expect(verifyIdentityAdmission(assertion!, {
        ...common,
        ...binding,
      })).resolves.toBeNull();
    }
  });

  it('rejects caller tampering', async () => {
    const assertion = await signIdentityAdmission({
      authorization: 'Bearer verified-token',
      method: 'GET',
      pathname: '/api/profile',
      state: 'active',
      user: USER,
      secret: SECRET,
    });
    const [payload, signature] = assertion!.split('.');
    const tampered = `${payload?.slice(0, -1)}A.${signature}`;

    await expect(verifyIdentityAdmission(tampered, {
      authorization: 'Bearer verified-token',
      method: 'GET',
      pathname: '/api/profile',
      secret: SECRET,
    })).resolves.toBeNull();
  });
});
