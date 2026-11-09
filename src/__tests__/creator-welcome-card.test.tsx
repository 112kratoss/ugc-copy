import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateCredits: vi.fn(),
}));

// The shared welcome reader (welcome-credits-requests.ts) takes the token from the browser's
// session: a signed-in one here, so its request reaches the stubbed fetch below.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token', user: { id: 'session-user' } } } }),
    },
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'token-1', user: { id: 'user-1' } },
    user: { id: 'user-1', email: 'asha@example.com', user_metadata: { full_name: 'Asha Rao' } },
    updateCredits: mocks.updateCredits,
  }),
}));

import CreatorWelcomeCard from '@/components/CreatorWelcomeCard';
import { WELCOME_OFFER_CHANGED_EVENT } from '@/lib/welcome-credits-popup';

type WelcomeAnswer = { status: string; amount: number; credits: number; identityComplete: boolean };

const NEW_PROFILE = { id: 'user-1', username: 'creator-a1b2c3d4', displayName: null };

function installFetch({ welcome }: { welcome: WelcomeAnswer }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let profile: Record<string, unknown> = { ...NEW_PROFILE };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === '/api/credits/welcome') return json(welcome);
    if (url === '/api/profile/validate') return json({ ok: true });
    if (url === '/api/profile' && method === 'PATCH') {
      profile = { ...profile, username: body.username, displayName: body.displayName };
      return json(profile);
    }
    if (url === '/api/profile') return json(profile);
    return json({ error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('the creator’s greeting for an account back from sign-up', () => {
  beforeEach(() => {
    mocks.updateCredits.mockReset();
    window.history.replaceState({}, '', '/create-video?prompt=boat&welcome=1&referral=applied');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  // The claim is the welcome popup's on every page (owner, 2026-11-09): the card
  // saves the name and handle the claim needs, and tells the popup to ask again.
  it('asks a new account for its name and handle, filled in from the sign-in, saves them with one press and leaves the credits to the popup', async () => {
    const calls = installFetch({ welcome: { status: 'not_eligible', amount: 25, credits: 0, identityComplete: false } });
    const offerChanges = vi.fn();
    window.addEventListener(WELCOME_OFFER_CHANGED_EVENT, offerChanges);
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    expect(await screen.findByRole('heading', { name: 'Pick your name and handle' })).toBeInTheDocument();
    expect(screen.getByText(/they unlock your 25 free credits/)).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('Asha Rao');
    const handle = (screen.getByLabelText('Handle') as HTMLInputElement).value;
    expect(handle).toMatch(/^[a-z0-9-]{3,24}$/);
    expect(handle).not.toMatch(/^creator-/);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('heading', { name: 'Your name and handle are saved' })).toBeInTheDocument();
    expect(screen.getByText(/nothing has been spent/)).toBeInTheDocument();
    const patch = calls.find((call) => call.url === '/api/profile' && call.method === 'PATCH');
    expect(patch?.body).toEqual({ username: handle, displayName: 'Asha Rao' });
    expect(calls.some((call) => call.url === '/api/credits/welcome/claim')).toBe(false);
    expect(mocks.updateCredits).not.toHaveBeenCalled();
    expect(offerChanges).toHaveBeenCalledTimes(1);
    window.removeEventListener(WELCOME_OFFER_CHANGED_EVENT, offerChanges);
  });

  // React runs a development effect twice (Next's dev server renders in StrictMode). The card
  // once started its reads in the first run only, whose answer the cleanup threw away, and drew
  // nothing at all (the E2E spec caught it, 2026-10-28).
  it('draws the card when its effect is run twice, as in development', async () => {
    const calls = installFetch({ welcome: { status: 'not_eligible', amount: 25, credits: 0, identityComplete: false } });
    render(<StrictMode><CreatorWelcomeCard welcome={{ referral: null }} carriedDraft /></StrictMode>);

    expect(await screen.findByRole('heading', { name: 'Pick your name and handle' })).toBeInTheDocument();
    expect(calls.filter((call) => call.url === '/api/credits/welcome').length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the address free of the flags that brought the account here, through Next’s own history handling', async () => {
    window.history.replaceState({ __NA: true }, '', '/create-video?prompt=boat&handover=nonce-1234&welcome=1&referral=applied');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    installFetch({ welcome: { status: 'already_claimed', amount: 25, credits: 3, identityComplete: true } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    await waitFor(() => expect(window.location.search).toBe('?prompt=boat'));
    // A state of Next's own (`__NA`) would skip its router: the router keeps the old address.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/create-video?prompt=boat');
    replaceState.mockRestore();
  });

  it('says when the welcome credits could not be read, keeps the flags for a reload, and asks again', async () => {
    let fail = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (url === '/api/credits/welcome') {
        return fail ? json({ error: 'Too many requests' }, 429) : json({ status: 'not_eligible', amount: 25, credits: 0, identityComplete: false });
      }
      if (url === '/api/profile') return json(NEW_PROFILE);
      return json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    expect(await screen.findByRole('heading', { name: 'Your welcome credits could not be read' })).toBeInTheDocument();
    expect(window.location.search).toContain('welcome=1');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Pick your name and handle' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe('?prompt=boat'));
  });

  it('promises the form only when the visitor’s draft came back with the account', async () => {
    installFetch({ welcome: { status: 'already_claimed', amount: 25, credits: 3, identityComplete: true } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft={false} />);

    expect(await screen.findByText('Press Generate when you’re ready; nothing has been spent.')).toBeInTheDocument();
    expect(screen.queryByText(/as you left them/)).not.toBeInTheDocument();
  });

  it('refuses a name or handle the rules refuse before asking the server', async () => {
    const calls = installFetch({ welcome: { status: 'not_eligible', amount: 25, credits: 0, identityComplete: false } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true'));
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(calls.some((call) => call.url === '/api/credits/welcome/claim')).toBe(false);
  });

  it('leaves waiting credits to the popup for an account that already has its name and handle', async () => {
    const calls = installFetch({ welcome: { status: 'eligible', amount: 25, credits: 0, identityComplete: true } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    expect(await screen.findByRole('heading', { name: 'You’re signed in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /credits/ })).not.toBeInTheDocument();
    expect(calls.some((call) => call.url === '/api/credits/welcome/claim')).toBe(false);
  });

  it('only says the form is back to an account with nothing to add, with how its invite went', async () => {
    installFetch({ welcome: { status: 'already_claimed', amount: 25, credits: 3, identityComplete: true } });
    render(<CreatorWelcomeCard welcome={{ referral: 'applied' }} carriedDraft />);

    expect(await screen.findByRole('heading', { name: 'You’re signed in' })).toBeInTheDocument();
    expect(screen.getByText(/Invite applied/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /credits/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'You’re signed in' })).not.toBeInTheDocument();
  });

  it('says why on the first read when this sign-in already had its welcome credits', async () => {
    installFetch({ welcome: { status: 'identity_already_claimed', amount: 25, credits: 0, identityComplete: false } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    expect(await screen.findByText(/already had its welcome credits on another account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /credits/ })).not.toBeInTheDocument();
  });

  it('can be put away for now', async () => {
    installFetch({ welcome: { status: 'not_eligible', amount: 25, credits: 0, identityComplete: false } });
    render(<CreatorWelcomeCard welcome={{ referral: null }} carriedDraft />);

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('heading', { name: 'Pick your name and handle' })).not.toBeInTheDocument();
  });
});
