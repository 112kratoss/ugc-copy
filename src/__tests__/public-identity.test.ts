import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  checkHandleAvailability,
  claimPublicIdentity,
  getInitialPublicIdentity,
  shouldCheckHandleAvailability,
} from '@/lib/public-identity';

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

// The handle is checked as it is typed, so a taken one shows beside the field
// instead of after the press (the app's Edit profile and onboarding do this).
describe('checking a handle while it is typed', () => {
  it('asks only once both fields pass the local rules, and never about the account\'s own handle', () => {
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'maya-k' }, 'creator-a1b2c3d4')).toBe(true);
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'maya-k' }, null)).toBe(true);
    // The server judges the whole submission: a blank name is a refusal about the name.
    expect(shouldCheckHandleAvailability({ displayName: '  ', username: 'maya-k' }, null)).toBe(false);
    // Said by the form, with no round trip.
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'ma' }, null)).toBe(false);
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'creator-a1b2c3d4' }, null)).toBe(false);
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'admin' }, null)).toBe(false);
    // Theirs already: nobody else can take it.
    expect(shouldCheckHandleAvailability({ displayName: 'Maya K', username: 'maya-k' }, 'maya-k')).toBe(false);
  });

  describe('the server\'s word', () => {
    const fetchMock = vi.fn();
    const draft = { displayName: ' Maya K ', username: 'maya-k' };

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends the two fields to the profile check with the token', async () => {
      fetchMock.mockResolvedValueOnce(json({ ok: true }));

      await expect(checkHandleAvailability(draft, 'token')).resolves.toEqual({ state: 'available' });
      expect(fetchMock).toHaveBeenCalledWith('/api/profile/validate', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ username: 'maya-k', displayName: 'Maya K' }),
      }));
    });

    it('reports a taken or refused handle in the server\'s words', async () => {
      // The 409 both server paths that refuse a handle send, which names the field.
      const taken = mobileApiContract.profileUsernameTaken;
      fetchMock
        .mockResolvedValueOnce(json(taken.response, taken.status))
        .mockResolvedValueOnce(json({ error: 'That handle is reserved.', fieldErrors: { username: 'That handle is reserved.' } }, 400));

      await expect(checkHandleAvailability(draft, 'token')).resolves.toEqual({ state: 'taken', message: 'That username is already taken.' });
      await expect(checkHandleAvailability(draft, 'token')).resolves.toEqual({ state: 'taken', message: 'That handle is reserved.' });
    });

    // Offline, rate limited or a refusal about the name says nothing about the
    // handle: the field goes back to its rule, and the save still judges.
    it('gives no verdict when the answer is not about the handle', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: 'Please fix the highlighted fields.', fieldErrors: { displayName: 'Add a display name for your public profile.' } }, 400))
        .mockResolvedValueOnce(json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429))
        .mockResolvedValueOnce(json({ error: 'Failed to validate username' }, 500))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(checkHandleAvailability(draft, 'token')).resolves.toBeNull();
      }
    });

    // As the app reads it (#550): a 409 is the handle's only when it names the
    // field. The proxy's 409s for a merged guest session or an account being
    // deleted name none, whatever the handle, and so does an empty answer.
    it('gives no verdict on a 409 that names no field', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: 'This guest session was linked to an account. Sign in to continue.', code: 'SESSION_MERGED' }, 409))
        .mockResolvedValueOnce(json({ error: 'This account is being deleted.', code: 'ACCOUNT_DELETING' }, 409))
        .mockResolvedValueOnce(json({}, 409));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(checkHandleAvailability(draft, 'token')).resolves.toBeNull();
      }
    });
  });
});
