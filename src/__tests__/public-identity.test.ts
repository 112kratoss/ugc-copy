import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimPublicIdentity, getInitialPublicIdentity } from '@/lib/public-identity';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const placeholderProfile = {
  id: 'user-1',
  username: 'creator-a1b2c3d4',
  suggestedUsername: 'creator-a1b2c3d4',
  displayName: null,
};

describe('where the name and handle fields start', () => {
  it('keeps what the profile already has', () => {
    expect(getInitialPublicIdentity({ username: 'maya-k', displayName: 'Maya K' }, null))
      .toEqual({ displayName: 'Maya K', username: 'maya-k' });
  });

  it('takes the sign-in name, else the email, and suggests a handle from it', () => {
    expect(getInitialPublicIdentity(
      { username: 'creator-a1b2c3d4', displayName: null },
      { email: 'maya@example.com', user_metadata: { full_name: 'Maya Kapoor' } },
    )).toEqual({ displayName: 'Maya Kapoor', username: 'maya-kapoor' });
    expect(getInitialPublicIdentity(null, { email: 'maya.k@example.com', user_metadata: {} }))
      .toEqual({ displayName: 'maya.k', username: 'maya-k' });
  });

  // A reserved handle would only be refused at save, after the press.
  it('never suggests a reserved handle', () => {
    expect(getInitialPublicIdentity(null, { email: 'maya.k@example.com', user_metadata: { name: 'Admin' } }))
      .toEqual({ displayName: 'Admin', username: 'maya-k' });
    expect(getInitialPublicIdentity(null, { email: 'support@example.com', user_metadata: { name: 'Support' } }).username)
      .toBe('');
  });
});

// The profile is read again at the press, so values a composer read earlier
// never replace a handle claimed in another tab since.
describe('saving the name and handle before a public post', () => {
  const fetchMock = vi.fn();
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves nothing when the profile can already publish', async () => {
    const finished = { ...placeholderProfile, username: 'maya', displayName: 'Maya' };
    fetchMock.mockResolvedValueOnce(json(finished));

    await expect(claimPublicIdentity({ displayName: 'Maya K', username: 'maya-k' }, 'token'))
      .resolves.toEqual({ ok: true, profile: finished });
    expect(patches()).toHaveLength(0);
  });

  it('saves the two fields when it cannot, or when it cannot be read', async () => {
    fetchMock
      .mockResolvedValueOnce(json(placeholderProfile))
      .mockResolvedValueOnce(json({ ...placeholderProfile, username: 'maya-k', displayName: 'Maya K' }))
      .mockResolvedValueOnce(json({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(json({ ...placeholderProfile, username: 'maya-k', displayName: 'Maya K' }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const saved = await claimPublicIdentity({ displayName: ' Maya K ', username: 'maya-k' }, 'token');
      expect(saved.ok).toBe(true);
    }
    expect(patches()).toHaveLength(2);
    expect(JSON.parse(String(patches()[0][1]?.body))).toEqual({ username: 'maya-k', displayName: 'Maya K' });
    expect(patches()[0][1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('brings a taken handle back on its field', async () => {
    fetchMock
      .mockResolvedValueOnce(json(placeholderProfile))
      .mockResolvedValueOnce(json({
        error: 'That username is already taken.',
        fieldErrors: { username: 'That username is already taken.' },
      }, 409));

    await expect(claimPublicIdentity({ displayName: 'Maya K', username: 'maya' }, 'token')).resolves.toEqual({
      ok: false,
      errors: { username: 'That username is already taken.' },
      message: 'That username is already taken.',
    });
  });
});
