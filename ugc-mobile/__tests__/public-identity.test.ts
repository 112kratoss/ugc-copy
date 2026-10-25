import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import { claimPublicIdentity, isPublicIdentityRefusal } from '../lib/public-identity';

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
