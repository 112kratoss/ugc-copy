import { describe, expect, it, vi } from 'vitest';

import { AccountDeletingError, ApiError, SessionMergedError } from '../lib/api-client';
import { claimPublicIdentity, isPublicIdentityRefusal, readPublicIdentitySaveError } from '../lib/public-identity';

const placeholderProfile = { id: 'user-1', username: 'creator-a1b2c3d4', displayName: null };

describe('the refusal for a public post\'s name and handle', () => {
  it('is told from every other refusal by the field the server names', () => {
    expect(isPublicIdentityRefusal(new ApiError('Complete your profile before publishing publicly.', 400, { field: 'profile' }))).toBe(true);
    expect(isPublicIdentityRefusal(new ApiError('Add a title.', 400, { field: 'title' }))).toBe(false);
    expect(isPublicIdentityRefusal(new ApiError('Complete your profile before publishing publicly.', 400))).toBe(false);
    expect(isPublicIdentityRefusal(new Error('profile'))).toBe(false);
  });
});

// The composer and the sheet a list opens make one claim: the profile is read
// again first, so values read earlier never replace a handle claimed since.
describe('claiming the name and handle', () => {
  it('saves nothing over a profile that can already publish', async () => {
    const finished = { ...placeholderProfile, username: 'maya', displayName: 'Maya' };
    const api = { getProfile: vi.fn(async () => finished), updateProfile: vi.fn() };

    await expect(claimPublicIdentity(api as never, { displayName: 'Maya K', username: 'maya-k' })).resolves.toBe(finished);
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('saves the two fields, trimmed, when it cannot, or cannot be read', async () => {
    const api = {
      getProfile: vi.fn()
        .mockResolvedValueOnce(placeholderProfile)
        .mockRejectedValueOnce(new Error('Network request failed.')),
      updateProfile: vi.fn(async (body: Record<string, unknown>) => ({ ...placeholderProfile, ...body })),
    };

    await claimPublicIdentity(api as never, { displayName: ' Maya K ', username: 'maya-k ' });
    await claimPublicIdentity(api as never, { displayName: 'Maya K', username: 'maya-k' });

    expect(api.updateProfile).toHaveBeenCalledTimes(2);
    expect(api.updateProfile).toHaveBeenNthCalledWith(1, { username: 'maya-k', displayName: 'Maya K' });
  });

  it('passes a taken handle on to the caller', async () => {
    const taken = new ApiError('That username is already taken.', 409, { fieldErrors: { username: 'That username is already taken.' } });
    const api = { getProfile: vi.fn(async () => placeholderProfile), updateProfile: vi.fn(async () => { throw taken; }) };

    await expect(claimPublicIdentity(api as never, { displayName: 'Maya K', username: 'maya' })).rejects.toBe(taken);
  });
});

// What the composer's step 2 and the list's sheet say about a failed claim.
describe('reading a failed save of the name and handle', () => {
  it('says a refusal of the handle on the handle', () => {
    const taken = new ApiError('That username is already taken.', 409, {
      error: 'That username is already taken.',
      fieldErrors: { username: 'That username is already taken.' },
    });

    expect(readPublicIdentitySaveError(taken)).toEqual({
      errors: { username: 'That username is already taken.' },
      message: 'That username is already taken.',
    });
  });

  // The proxy's two 409s name no field: they refuse the session, whatever the
  // handle, and the app's handler for each ends it. The sheet stays up through
  // that, so its line is read beside the handler's own words.
  it.each([
    ['a guest session linked to an account', new SessionMergedError(
      'This guest session has been linked to an account. Sign in to continue.',
      { error: 'This guest session has been linked to an account. Sign in to continue.', code: 'SESSION_MERGED' },
    )],
    ['an account being deleted', new AccountDeletingError(
      'This account is being permanently deleted.',
      { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' },
    )],
  ])('says a save refused for %s above the fields, in the server\'s words', (_why, refusal) => {
    expect(readPublicIdentitySaveError(refusal)).toEqual({ errors: {}, message: refusal.message });
  });
});
