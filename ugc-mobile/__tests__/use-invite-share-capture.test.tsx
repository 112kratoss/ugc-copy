(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auth: {
    api: { recordReferralVisit: () => undefined },
    // The registered account, null for a guest and for nobody (`lib/auth.tsx`).
    user: null as { id: string } | null,
    isLoading: false,
  },
  capturePendingReferral: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => state.auth }));
vi.mock('../lib/referral-attribution', () => ({ capturePendingReferral: state.capturePendingReferral }));

import {
  INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS,
  captureInviteFromSharedLink,
  inviteShareCaptureDecision,
  inviteShareParam,
  resetInviteShareCapturesForTests,
  useInviteShareCapture,
} from '../lib/use-invite-share-capture';

const CODE = '30b5f916c7aa';
const OTHER_CODE = 'aaaaaaaa1111';

function Host({ code, next }: { code: string | string[] | undefined; next: string | null }) {
  useInviteShareCapture(code, next);
  return null;
}

function mount(code: string | string[] | undefined, next: string | null = '/showcase/post-1') {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Host code={code} next={next} />);
  });
  return {
    update: (nextCode: string | string[] | undefined, nextPath: string | null = next) => act(() => {
      tree.update(<Host code={nextCode} next={nextPath} />);
    }),
    // The same screen drawn again: what a session that settles does to it.
    redraw: () => act(() => {
      tree.update(<Host code={code} next={next} />);
    }),
  };
}

beforeEach(() => {
  vi.useRealTimers();
  resetInviteShareCapturesForTests();
  state.auth.user = null;
  state.auth.isLoading = false;
  state.capturePendingReferral.mockReset().mockResolvedValue({ pending: { code: CODE }, keptEarlierInvite: false });
});

describe('what a shared link does with its invite', () => {
  it('records it for someone with no account, waits for the session, and skips an account', () => {
    expect(inviteShareCaptureDecision({ code: CODE, isAuthLoading: false, hasAccount: false })).toBe('capture');
    expect(inviteShareCaptureDecision({ code: CODE, isAuthLoading: true, hasAccount: false })).toBe('wait');
    expect(inviteShareCaptureDecision({ code: CODE, isAuthLoading: false, hasAccount: true })).toBe('skip');
    // A signed-in account is never taken for a visitor while its session is read.
    expect(inviteShareCaptureDecision({ code: CODE, isAuthLoading: true, hasAccount: true })).toBe('wait');
    // No invite on the link: nothing to wait for.
    expect(inviteShareCaptureDecision({ code: null, isAuthLoading: true, hasAccount: false })).toBe('skip');
  });

  it('reads the link\'s first value, and only a code', () => {
    expect(inviteShareParam(CODE)).toBe(CODE);
    expect(inviteShareParam([CODE, OTHER_CODE])).toBe(CODE);
    expect(inviteShareParam('30B5F916C7AA')).toBe(CODE);
    expect(inviteShareParam(undefined)).toBeNull();
    expect(inviteShareParam([])).toBeNull();
    expect(inviteShareParam('short')).toBeNull();
    expect(inviteShareParam('../../admin')).toBeNull();
  });
});

describe('a page opened by a shared link', () => {
  it('records the invite once for a visitor, with the page it came for', () => {
    const screen = mount(CODE);

    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
    // As a shared link's: an invite link opened later replaces it.
    expect(state.capturePendingReferral).toHaveBeenCalledWith(state.auth.api, CODE, { next: '/showcase/post-1', kind: 'shared_link' });

    screen.redraw();
    screen.redraw();
    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
  });

  it('records it once under StrictMode, where effects run twice', () => {
    act(() => {
      renderer.create(<React.StrictMode><Host code={CODE} next="/showcase/post-1" /></React.StrictMode>);
    });

    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
  });

  it('waits until the session has been read, then records for a visitor', () => {
    state.auth.isLoading = true;
    const screen = mount(CODE);
    expect(state.capturePendingReferral).not.toHaveBeenCalled();

    state.auth.isLoading = false;
    screen.redraw();
    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
  });

  it('records nothing for an account, even after it signs out on that page', () => {
    state.auth.isLoading = true;
    state.auth.user = { id: 'account-a' };
    const screen = mount(CODE);

    state.auth.isLoading = false;
    screen.redraw();
    expect(state.capturePendingReferral).not.toHaveBeenCalled();

    // The sharer opening their own link, then signing out, is not a new person.
    state.auth.user = null;
    screen.redraw();
    expect(state.capturePendingReferral).not.toHaveBeenCalled();
  });

  it('records nothing for a link with no invite, or one that is not a code', () => {
    mount(undefined);
    mount('short');
    mount('not-a-code!');

    expect(state.capturePendingReferral).not.toHaveBeenCalled();
  });

  it('waits for the page to know its own path', () => {
    const screen = mount(CODE, null);
    expect(state.capturePendingReferral).not.toHaveBeenCalled();

    screen.update(CODE, '/creators/luna');
    expect(state.capturePendingReferral).toHaveBeenCalledWith(state.auth.api, CODE, { next: '/creators/luna', kind: 'shared_link' });
  });

  // A visit that failed was never tried again, and the saved code without a
  // visit made the sign-up's claim throw (review of 2026-11-10).
  it('tries a failed capture again, quietly, while the screen is open', async () => {
    vi.useFakeTimers();
    state.capturePendingReferral
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockRejectedValueOnce(new Error('Too many requests'))
      .mockResolvedValue({ pending: { code: CODE, visitToken: 'visit-1' }, keptEarlierInvite: false });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    mount(CODE);
    await act(async () => { await vi.advanceTimersByTimeAsync(INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS[0]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS[1]); });
    process.off('unhandledRejection', unhandled);

    expect(state.capturePendingReferral).toHaveBeenCalledTimes(3);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('stops trying once the screen is gone', async () => {
    const sleeps: number[] = [];
    let current = true;
    state.capturePendingReferral.mockRejectedValue(new Error('Network request failed'));

    const captured = captureInviteFromSharedLink(state.auth.api as never, CODE, '/showcase/post-1', () => current, async (ms) => {
      sleeps.push(ms);
      current = false;
    });

    await expect(captured).resolves.toBe(false);
    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS[0]]);
  });

  // The legacy-id resolver re-opens the post page with the same link: one
  // capture per code per run (review of 2026-11-10).
  it('captures one code once however many screens ask', async () => {
    mount(CODE);
    mount(CODE, '/creators/luna');
    await act(async () => { await Promise.resolve(); });

    expect(state.capturePendingReferral).toHaveBeenCalledTimes(1);
  });
});
