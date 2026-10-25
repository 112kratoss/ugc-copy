import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const chunk = vi.hoisted(() => ({ failures: Number.POSITIVE_INFINITY }));

// The question's chunk cannot be fetched: a deploy rotated the chunk names
// while the tab was open, or the connection dropped as it was asked.
vi.mock('@/components/PublicIdentityDialog', async (importOriginal) => {
  if (chunk.failures > 0) {
    chunk.failures -= 1;
    throw new Error('Loading chunk app/PublicIdentityDialog failed.');
  }
  return importOriginal();
});

import FeedbackViewport from '@/components/FeedbackViewport';
import {
  pushToast,
  requestPublicIdentity,
  resetFeedbackState,
  type PublicIdentityOutcome,
} from '@/components/feedback-state';

describe('the name-and-handle question when it cannot be loaded', () => {
  afterEach(() => {
    resetFeedbackState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is answered "unavailable", so the caller says what it would have, and the page stays', async () => {
    chunk.failures = Number.POSITIVE_INFINITY;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<FeedbackViewport />);

    let answer: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'cancelled' });
    act(() => {
      answer = requestPublicIdentity({ getAccessToken: () => 'token' });
    });

    await expect(answer).resolves.toEqual({ status: 'unavailable' });
    expect(consoleError).toHaveBeenCalledWith('Failed to load the name-and-handle question:', expect.any(Error));
    // The viewport is still there to draw what the caller says instead.
    act(() => {
      pushToast({ tone: 'error', message: 'Complete your profile before publishing publicly.' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Complete your profile before publishing publicly.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('loads it for a later question once the chunk can be fetched again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'user-1',
      username: 'creator-a1b2c3d4',
      suggestedUsername: 'creator-a1b2c3d4',
      displayName: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    chunk.failures = 1;
    render(<FeedbackViewport />);

    let first: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'cancelled' });
    act(() => {
      first = requestPublicIdentity({ getAccessToken: () => 'token' });
    });
    await expect(first).resolves.toEqual({ status: 'unavailable' });

    // Back online: the next question tries the chunk again instead of
    // throwing the first failure forever.
    let second: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'unavailable' });
    act(() => {
      second = requestPublicIdentity({ getAccessToken: () => 'token' });
    });
    expect(await screen.findByRole('dialog', { name: 'Add your name and handle' })).toBeInTheDocument();
    act(() => {
      screen.getByRole('button', { name: 'Cancel' }).click();
    });
    await expect(second).resolves.toEqual({ status: 'cancelled' });
  });
});
