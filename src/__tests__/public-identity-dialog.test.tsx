import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackViewport from '@/components/FeedbackViewport';
import {
  requestPublicIdentity,
  resetFeedbackState,
  type PublicIdentityOutcome,
} from '@/components/feedback-state';

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

/** The server: the profile, the live check (`taken` handles are someone else's) and the save. */
function serve({ taken = [] as string[], saveStatus = 200 } = {}) {
  let profile: Record<string, unknown> = { ...placeholderProfile };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { username?: string; displayName?: string } : {};
    if (url === '/api/profile/validate') {
      return taken.includes(body.username ?? '')
        ? json({ error: 'That username is already taken.', fieldErrors: { username: 'That username is already taken.' } }, 409)
        : json({ ok: true });
    }
    if (url === '/api/profile' && init?.method === 'PATCH') {
      if (saveStatus !== 200 || taken.includes(body.username ?? '')) {
        return json({ error: 'That username is already taken.', fieldErrors: { username: 'That username is already taken.' } }, 409);
      }
      profile = { ...profile, ...body };
      return json(profile);
    }
    if (url === '/api/profile') {
      return json(profile);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

const MAYA = { email: 'maya.k@example.com', user_metadata: { full_name: 'Maya Kapoor' } };

async function ask(signedInUser: typeof MAYA | null = MAYA) {
  let answer: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'unavailable' });
  act(() => {
    answer = requestPublicIdentity({ accessToken: 'token', signedInUser });
  });
  await screen.findByRole('dialog', { name: 'Add your name and handle' });
  return answer;
}

const handleField = () => screen.getByLabelText('Handle') as HTMLInputElement;
const nameField = () => screen.getByLabelText('Display name') as HTMLInputElement;
const handleHint = () => document.getElementById(handleField().getAttribute('aria-describedby') ?? '');

describe('the name-and-handle question a list asks before a post goes public', () => {
  let fetchMock: ReturnType<typeof serve>;

  beforeEach(() => {
    fetchMock = serve({ taken: ['maya-kapoor'] });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetFeedbackState();
    vi.unstubAllGlobals();
  });

  it('starts from the profile and the sign-in, as the composers do', async () => {
    render(<FeedbackViewport />);
    void ask();

    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));
    expect(handleField().value).toBe('maya-kapoor');
    expect(fetchMock).toHaveBeenCalledWith('/api/profile', expect.objectContaining({
      headers: { Authorization: 'Bearer token' },
    }));
  });

  it('says a taken handle beside the field as it is typed, and an available one too', async () => {
    render(<FeedbackViewport />);
    void ask();

    // The suggestion is someone else's: said before any press.
    await waitFor(() => expect(handleHint()).toHaveTextContent('That username is already taken.'), { timeout: 2000 });
    expect(handleField()).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    expect(handleHint()).toHaveTextContent('Checking availability…');
    await waitFor(() => expect(handleHint()).toHaveTextContent('This handle is available.'), { timeout: 2000 });
    expect(handleField()).not.toHaveAttribute('aria-invalid');
    expect(fetchMock).toHaveBeenCalledWith('/api/profile/validate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'maya-k', displayName: 'Maya Kapoor' }),
    }));
  });

  it('saves both with the composers\' claim and answers with the saved profile', async () => {
    render(<FeedbackViewport />);
    const answer = ask();
    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));

    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and make public' }));

    await expect(answer).resolves.toEqual({
      status: 'saved',
      profile: expect.objectContaining({ username: 'maya-k', displayName: 'Maya Kapoor' }),
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ username: 'maya-k', displayName: 'Maya Kapoor' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays open with the refusal on the handle when the save finds it taken', async () => {
    fetchMock = serve({ saveStatus: 409 });
    vi.stubGlobal('fetch', fetchMock);
    render(<FeedbackViewport />);
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);
    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));

    fireEvent.click(screen.getByRole('button', { name: 'Save and make public' }));

    await waitFor(() => expect(handleHint()).toHaveTextContent('That username is already taken.'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and make public' })).not.toBeDisabled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('asks for what the form can say before saving anything', async () => {
    render(<FeedbackViewport />);
    void ask(null);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/profile', expect.anything()));

    fireEvent.click(screen.getByRole('button', { name: 'Save and make public' }));

    expect(await screen.findByText('Add a display name for your public profile.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('is answered "cancelled" by Cancel, Escape and the backdrop', async () => {
    render(<FeedbackViewport />);

    let answer = ask();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toEqual({ status: 'cancelled' });

    answer = ask();
    fireEvent.keyDown(window, { key: 'Escape' });
    await expect(answer).resolves.toEqual({ status: 'cancelled' });

    answer = ask();
    fireEvent.click(document.querySelector('.ui-confirm-backdrop') as Element);
    await expect(answer).resolves.toEqual({ status: 'cancelled' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('answers "unavailable" at once when nothing can draw it', async () => {
    await expect(requestPublicIdentity({ accessToken: 'token' })).resolves.toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
