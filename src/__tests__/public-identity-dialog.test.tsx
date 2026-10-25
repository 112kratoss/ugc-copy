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

async function ask(signedInUser: typeof MAYA | null = MAYA, getAccessToken: () => string | null = () => 'token') {
  let answer: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'unavailable' });
  act(() => {
    answer = requestPublicIdentity({ getAccessToken, signedInUser });
  });
  await screen.findByRole('dialog', { name: 'Add your name and handle' });
  return answer;
}

const handleField = () => screen.getByLabelText('Handle') as HTMLInputElement;
const nameField = () => screen.getByLabelText('Display name') as HTMLInputElement;
const handleHint = () => document.getElementById(handleField().getAttribute('aria-describedby') ?? '');
const saveButton = () => screen.getByRole('button', { name: /Save and make public|Saving…/ });
const checks = (fetchMock: ReturnType<typeof serve>) => fetchMock.mock.calls
  .filter(([url]) => String(url) === '/api/profile/validate');

/** A Back (or Forward) to `path`, as the browser reports it. */
function goBackTo(path: string) {
  act(() => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/** Wraps a server so that one kind of request waits until it is let go. */
function holding(fetchMock: ReturnType<typeof serve>, matches: (url: string, init?: RequestInit) => boolean) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (matches(String(input), init)) {
      await held;
    }
    return fetchMock(input, init);
  });
  return { fetch: wrapped, release };
}

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

    const nameError = await screen.findByText('Add a display name for your public profile.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    // One colour class, the danger one: with the caption's faint colour beside
    // it, the stylesheet's order drew the error grey.
    expect(nameError.className).toContain('text-[var(--ui-accent-danger)]');
    expect(nameError.className).not.toContain('text-[var(--ui-text-faint)]');
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
    await expect(requestPublicIdentity({ getAccessToken: () => 'token' })).resolves.toEqual({ status: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads and saves with the token the page holds by then, not the one it was asked with', async () => {
    render(<FeedbackViewport />);
    // The session refreshes while the question is up: the page's token moves on.
    let token = 'token';
    const answer = ask(MAYA, () => token);
    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));
    token = 'refreshed-token';

    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    fireEvent.click(saveButton());

    await expect(answer).resolves.toEqual(expect.objectContaining({ status: 'saved' }));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer refreshed-token' }));
  });

  it('lets a second question wait on the one that is up, and answers both at once', async () => {
    render(<FeedbackViewport />);
    const first = ask();
    let second: Promise<PublicIdentityOutcome> = Promise.resolve({ status: 'unavailable' });
    act(() => {
      second = requestPublicIdentity({ getAccessToken: () => 'token', signedInUser: MAYA });
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));

    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    fireEvent.click(saveButton());

    await expect(first).resolves.toEqual(expect.objectContaining({ status: 'saved' }));
    await expect(second).resolves.toEqual(expect.objectContaining({ status: 'saved' }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('is put away by a Back that leaves the page, and not by one that only changes the hash', async () => {
    window.history.replaceState(null, '', '/creations?view=posts');
    render(<FeedbackViewport />);
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);

    goBackTo('/creations?view=posts#top');
    await act(async () => undefined);
    expect(settled).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    goBackTo('/home');
    await expect(answer).resolves.toEqual({ status: 'cancelled' });
    window.history.replaceState(null, '', '/');
  });

  it('finishes a save that a Back to another page arrives during', async () => {
    window.history.replaceState(null, '', '/creations?view=posts');
    const server = holding(fetchMock, (url, init) => url === '/api/profile' && init?.method === 'PATCH');
    vi.stubGlobal('fetch', server.fetch);
    render(<FeedbackViewport />);
    const answer = ask();
    const settled = vi.fn();
    void answer.then(settled);
    await waitFor(() => expect(nameField().value).toBe('Maya Kapoor'));
    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeDisabled());

    goBackTo('/home');
    await act(async () => undefined);
    expect(settled).not.toHaveBeenCalled();

    server.release();
    await expect(answer).resolves.toEqual(expect.objectContaining({ status: 'saved' }));
    window.history.replaceState(null, '', '/');
  });

  it('keeps Tab inside the question and gives the focus back when it goes', async () => {
    render(
      <>
        <button type="button">Visibility of Window light study: Private</button>
        <FeedbackViewport />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Visibility of Window light study: Private' });
    opener.focus();
    const answer = ask();
    await waitFor(() => expect(nameField()).toHaveFocus());

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    saveButton().focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(nameField()).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(saveButton()).toHaveFocus();

    fireEvent.click(cancel);
    await expect(answer).resolves.toEqual({ status: 'cancelled' });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not ask about the same handle again when only the name changes', async () => {
    render(<FeedbackViewport />);
    void ask();
    await waitFor(() => expect(handleHint()).toHaveTextContent('That username is already taken.'), { timeout: 2000 });
    expect(checks(fetchMock)).toHaveLength(1);

    fireEvent.change(nameField(), { target: { value: 'Maya K.' } });
    expect(handleHint()).toHaveTextContent('That username is already taken.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(checks(fetchMock)).toHaveLength(1);

    // A new handle is asked about with the name as it stands.
    fireEvent.change(handleField(), { target: { value: 'maya-k' } });
    await waitFor(() => expect(handleHint()).toHaveTextContent('This handle is available.'), { timeout: 2000 });
    expect(JSON.parse(String(checks(fetchMock)[1]?.[1]?.body))).toEqual({ username: 'maya-k', displayName: 'Maya K.' });
  });

  it('checks the handle only once the profile has been read', async () => {
    // The profile already has a name, so its handle is made from that, not from the sign-in's.
    fetchMock = serve({ taken: ['maya-kapoor'] });
    const named = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchMock(input, init);
      if (String(input) === '/api/profile' && !init?.method) {
        return json({ ...placeholderProfile, displayName: 'Maya' });
      }
      return response;
    });
    const server = holding(named as unknown as ReturnType<typeof serve>, (url, init) => url === '/api/profile' && !init?.method);
    vi.stubGlobal('fetch', server.fetch);
    render(<FeedbackViewport />);
    void ask();

    // Outside act: inside it React would hold the field's effects, and with
    // them the check's timer, until the wait was over. Long enough for both:
    // the effects ran about 375 ms after the question appeared (the reveal of
    // its lazy chunk), and the check waits 400 ms more.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(checks(fetchMock)).toHaveLength(0);

    server.release();
    await waitFor(() => expect(nameField().value).toBe('Maya'));
    await waitFor(() => expect(checks(fetchMock)).toHaveLength(1), { timeout: 2000 });
    expect(JSON.parse(String(checks(fetchMock)[0]?.[1]?.body))).toEqual({ username: 'maya', displayName: 'Maya' });
  });
});
