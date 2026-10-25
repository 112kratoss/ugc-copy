import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The question's chunk cannot be fetched: a deploy rotated the chunk names
// while the tab was open, or the connection dropped as it was asked.
vi.mock('@/components/PublicIdentityDialog', () => {
  throw new Error('Loading chunk app/PublicIdentityDialog failed.');
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
  });

  it('is answered "unavailable", so the caller says what it would have, and the page stays', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<FeedbackViewport />);

    let answer: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'cancelled' });
    act(() => {
      answer = requestPublicIdentity({ accessToken: 'token' });
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
});
