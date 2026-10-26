// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountDeletingError, ApiError, SessionMergedError } from '../lib/api-client';
import { PROFILE_PLACEHOLDER_USERNAME_ERROR, RESERVED_PROFILE_USERNAME_ERROR } from '../lib/edit-profile-form';
import { HANDLE_CHECK_DELAY_MS, useHandleAvailability, type HandleAvailabilityState } from '../lib/use-handle-availability';

type Fields = { username: string; displayName: string; savedUsername?: string | null };

const api = { validateProfile: vi.fn() };
const mounted: renderer.ReactTestRenderer[] = [];

/** Renders the hook for one set of fields and reads what it says. */
function check(fields: Fields) {
  let state!: HandleAvailabilityState;
  function Probe(props: Fields) {
    state = useHandleAvailability(api, props);
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Probe {...fields} />);
  });
  mounted.push(tree);
  return {
    read: () => state,
    type: (next: Partial<Fields>) => act(() => tree.update(<Probe {...fields} {...next} />)),
  };
}

/** Lets the check's pause run out and its answer arrive. */
async function letTheCheckAnswer() {
  await act(async () => {
    vi.advanceTimersByTime(HANDLE_CHECK_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the live handle check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.validateProfile.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    act(() => {
      for (const tree of mounted.splice(0)) tree.unmount();
    });
    vi.useRealTimers();
  });

  // Every caller used to put these in front of the hook itself, and the
  // name-and-handle card did not: a new caller showed the rule for `support`.
  it('refuses a reserved handle in the server’s words, with no request', async () => {
    const live = check({ username: 'support', displayName: 'Maya' });

    expect(live.read()).toEqual({ availability: 'taken', message: RESERVED_PROFILE_USERNAME_ERROR });
    await letTheCheckAnswer();
    expect(live.read()).toEqual({ availability: 'taken', message: RESERVED_PROFILE_USERNAME_ERROR });
    expect(api.validateProfile).not.toHaveBeenCalled();
  });

  it('refuses the signup placeholder, before a name is typed too', async () => {
    const live = check({ username: 'creator-1a2b3c4d', displayName: '' });

    expect(live.read()).toEqual({ availability: 'taken', message: PROFILE_PLACEHOLDER_USERNAME_ERROR });
    await letTheCheckAnswer();
    expect(api.validateProfile).not.toHaveBeenCalled();
  });

  it('leaves a reserved handle the account already holds alone', async () => {
    const live = check({ username: 'support', displayName: 'Support', savedUsername: 'support' });

    await letTheCheckAnswer();
    expect(live.read()).toEqual({ availability: 'idle', message: null });
    expect(api.validateProfile).not.toHaveBeenCalled();
  });

  it('asks the server about any other handle once typing pauses', async () => {
    api.validateProfile.mockImplementation(async ({ username }: { username: string }) => {
      if (username === 'maya') {
        throw new ApiError('That username is already taken.', 409, {
          fieldErrors: { username: 'That username is already taken.' },
        });
      }
      return { ok: true };
    });
    const live = check({ username: 'maya', displayName: 'Maya' });

    expect(live.read()).toEqual({ availability: 'checking', message: null });
    await letTheCheckAnswer();
    expect(live.read()).toEqual({ availability: 'taken', message: 'That username is already taken.' });

    // A reserved handle typed after it is refused at once, with no new request.
    live.type({ username: 'admin' });
    expect(live.read()).toEqual({ availability: 'taken', message: RESERVED_PROFILE_USERNAME_ERROR });
    await letTheCheckAnswer();
    expect(api.validateProfile).toHaveBeenCalledTimes(1);

    live.type({ username: 'maya-k' });
    await letTheCheckAnswer();
    expect(live.read()).toEqual({ availability: 'available', message: null });
    expect(api.validateProfile).toHaveBeenLastCalledWith({ username: 'maya-k', displayName: 'Maya' });
  });

  // The proxy's two 409s name no field: they refuse the session, whatever the
  // handle, and the app's handler for each ends it. Read as the handle's, the
  // field called a free handle taken in the proxy's words.
  it.each([
    ['a guest session linked to an account', new SessionMergedError(
      'This guest session has been linked to an account. Sign in to continue.',
      { error: 'This guest session has been linked to an account. Sign in to continue.', code: 'SESSION_MERGED' },
    )],
    ['an account being deleted', new AccountDeletingError(
      'This account is being permanently deleted.',
      { error: 'This account is being permanently deleted.', code: 'ACCOUNT_DELETING' },
    )],
  ])('says nothing against the handle when the check is refused for %s', async (_why, refusal) => {
    api.validateProfile.mockRejectedValue(refusal);
    const live = check({ username: 'maya-k', displayName: 'Maya' });

    await letTheCheckAnswer();
    expect(api.validateProfile).toHaveBeenCalledTimes(1);
    expect(live.read()).toEqual({ availability: 'idle', message: null });
  });
});
