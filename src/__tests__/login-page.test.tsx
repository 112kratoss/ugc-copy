import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginClient, { type LoginClientProps } from '@/app/login/LoginClient';
import LoginPage from '@/app/login/page';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import { siteConfig } from '@/lib/seo';
import { resetWelcomePromiseForTests, WELCOME_PROMISE_STORAGE_KEY } from '@/lib/welcome-promise';

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  const back = vi.fn();
  return {
    replace,
    refresh,
    back,
    // One router object for every render: a fresh one each time re-runs the
    // page's session effect on every render.
    router: { replace, refresh, back },
    getSession: vi.fn(),
    signInWithOAuth: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    loadWelcomeCredits: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      signInWithOAuth: mocks.signInWithOAuth,
      signInWithPassword: mocks.signInWithPassword,
      signUp: mocks.signUp,
    },
  },
}));

vi.mock('@/lib/sign-in-page-server', () => ({
  loadSignInWelcomeCredits: mocks.loadWelcomeCredits,
  pickSignInWallStart: () => 0.42,
}));

// The wall is drawn on the server from static pictures; the page only places what it is given.
vi.mock('@/app/login/SignInWall', () => ({
  default: ({ start }: { start: number }) => <div data-testid="sign-in-wall" data-start={start} />,
}));

const HEADLINE = 'Start filling your Magic Booklet';
const AGREEMENT = 'By continuing you agree to the Terms and the Privacy Policy. Prompts and media you generate are processed by the AI providers listed in the policy.';
const RECOVERY_NOTICE = 'Password reset emails aren’t available. Signed up with Google or Apple? Continue with it below. Otherwise, email info@magicbooklet.com and we’ll help you sign in.';
const RETURN_NOTE = 'Your prompt and images stay, and nothing runs until you press Generate.';

const choices = () => screen.getByRole('region', { name: HEADLINE });
const emailHalf = () => screen.getByRole('region', { name: 'Sign in with email' });

/** jsdom draws no stylesheet, so a half's state is read from the page's own marks: `inert` and `data-away`. */
function expectShowing(half: 'choose' | 'email') {
  const [shown, away] = half === 'choose' ? [choices(), emailHalf()] : [emailHalf(), choices()];
  expect(shown).not.toHaveAttribute('inert');
  expect(shown).not.toHaveAttribute('data-away');
  expect(away).toHaveAttribute('inert');
  expect(away).toHaveAttribute('data-away');
}

function renderLogin(overrides: Partial<LoginClientProps> = {}) {
  return render(
    <LoginClient
      initialHalf="choose"
      recoveryRequested={false}
      redirectTo="/create"
      welcomeCredits={25}
      {...overrides}
    />,
  );
}

// Opens the page the way a link does: the server component reads the query,
// then renders the client with what it resolved.
async function renderPageAt(query: string) {
  return render(await LoginPage({
    searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(query))),
  }));
}

function providerRedirect(callIndex = 0) {
  const payload = mocks.signInWithOAuth.mock.calls[callIndex][0];
  return { provider: payload.provider, redirectTo: new URL(payload.options.redirectTo) };
}

function setPointer(fine: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(pointer: fine)' ? fine : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function setNavigation(canGoBack: boolean | undefined) {
  Object.defineProperty(window, 'navigation', {
    configurable: true,
    value: canGoBack === undefined ? undefined : { canGoBack },
  });
}

function fillSignInForm() {
  fireEvent.change(within(emailHalf()).getByLabelText('Email'), { target: { value: 'creator@example.com' } });
  fireEvent.change(within(emailHalf()).getByLabelText('Password'), { target: { value: 'Strong-password1!' } });
}

const submitButton = () => within(emailHalf()).getByRole('button', { name: /^(sign in|signing in…)$/i });

beforeEach(() => {
  mocks.replace.mockClear();
  mocks.refresh.mockClear();
  mocks.back.mockClear();
  mocks.signInWithOAuth.mockReset();
  mocks.signInWithPassword.mockReset();
  mocks.signUp.mockReset();
  mocks.getSession.mockReset();
  mocks.loadWelcomeCredits.mockReset();
  mocks.getSession.mockResolvedValue({ data: { session: null } });
  mocks.signInWithPassword.mockResolvedValue({ error: null });
  mocks.signInWithOAuth.mockResolvedValue({ error: null });
  mocks.loadWelcomeCredits.mockResolvedValue(25);
  window.history.replaceState(null, '', '/login?returnUrl=%2Fcreate');
  window.localStorage.clear();
  resetWelcomePromiseForTests();
  setPointer(false);
  setNavigation(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/login on the server', () => {
  it('resolves the query so the server’s HTML is the page asked for', async () => {
    mocks.loadWelcomeCredits.mockResolvedValue(30);
    const element = await LoginPage({
      searchParams: Promise.resolve({ recovery: '1', returnUrl: '/create-video', next: '/pricing' }),
    });

    expect(element.type).toBe(LoginClient);
    expect(element.props).toMatchObject({
      initialHalf: 'email',
      recoveryRequested: true,
      // `next` first, then `redirect`, then `returnUrl`, as before.
      redirectTo: '/pricing',
      welcomeCredits: 30,
    });
    // The visit's start along the wall's loop, drawn by the server.
    expect(element.props.wall.props.start).toBe(0.42);
  });

  it('opens on the choices, on the email form for `email=1`, and on the same page for the invite’s `mode=signup`', async () => {
    const half = async (query: Record<string, string>) => (await LoginPage({ searchParams: Promise.resolve(query) })).props.initialHalf;

    expect(await half({})).toBe('choose');
    expect(await half({ email: '1' })).toBe('email');
    expect(await half({ mode: 'signup', next: '/create' })).toBe('choose');
    expect(await half({ email: '0' })).toBe('choose');
  });

  it('keeps an unsafe return out', async () => {
    const element = await LoginPage({ searchParams: Promise.resolve({ returnUrl: 'https://evil.example/steal' }) });
    expect(element.props.redirectTo).toBe(getSafeAuthNextPath(null));
  });
});

describe('the choices', () => {
  it('draw the app’s page: the headline into the wordmark, the credits, Apple then Google, email as a way back in, and the terms', () => {
    renderLogin();
    const page = within(choices());

    expect(page.getByRole('heading', { level: 1, name: HEADLINE })).toBeInTheDocument();
    expect(page.getByRole('heading', { level: 1, name: HEADLINE }).querySelector('[data-brand-sparkle]')).not.toBeNull();
    expect(page.getByText(/Join free and get/)).toHaveTextContent('Join free and get 25 credits to start');

    const [apple, google] = page.getAllByRole('button', { name: /^Continue with/ });
    expect(apple).toHaveAccessibleName('Continue with Apple');
    expect(google).toHaveAccessibleName('Continue with Google');
    expect(apple).toHaveAccessibleDescription(AGREEMENT);
    expect(google).toHaveAccessibleDescription(AGREEMENT);

    // A link, so before the page's script runs it opens the form as its own page.
    expect(page.getByRole('link', { name: 'Made an account with email? Sign in' }))
      .toHaveAttribute('href', '/login?returnUrl=%2Fcreate&email=1');
    expect(page.getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/');

    // No Sign in / Sign up tabs: email makes no new accounts.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expectShowing('choose');
  });

  it('places the wall it is given behind the page', () => {
    renderLogin({ wall: <div data-testid="sign-in-wall" /> });
    expect(screen.getByTestId('sign-in-wall')).toBeInTheDocument();
  });

  // Both lines while the promise may stand: the root's mark (set before the page draws where
  // this browser's account had the credits) picks one in the browser's stylesheet.
  it('draws the line for a spent promise beside the promise, for the root’s mark to choose', () => {
    renderLogin();
    expect(within(choices()).getByText(/Join free and get/)).toHaveClass('welcome-promise-only');
    expect(within(choices()).getByText('Sign in or join free to start creating.')).toHaveClass('welcome-promise-spent-only');
  });

  it('promises no number while the welcome program is off or unread', () => {
    renderLogin({ welcomeCredits: null });
    const line = within(choices()).getByText('Sign in or join free to start creating.');
    expect(line).not.toHaveClass('welcome-promise-spent-only');
    expect(screen.queryByText(/credits to start/)).toBeNull();
  });

  // Owner, 2026-11-09: signed up, claimed, signed out, and still offered 25 credits (#738's rule).
  it('promises no credits where this browser’s account has had them', () => {
    window.localStorage.setItem(WELCOME_PROMISE_STORAGE_KEY, '2026-11-09T10:00:00.000Z');
    renderLogin();

    const line = within(choices()).getByText('Sign in or join free to start creating.');
    expect(line).not.toHaveClass('welcome-promise-spent-only');
    expect(screen.queryByText(/Join free and get/)).toBeNull();
  });

  it('says the draft stays, on both halves, only for a creator’s hand-over', () => {
    const view = renderLogin({ redirectTo: '/create-video?handover=nonce-1234' });

    expect(within(choices()).getByText(RETURN_NOTE)).toBeInTheDocument();
    expect(within(emailHalf()).getByText(RETURN_NOTE)).toBeInTheDocument();

    view.unmount();
    renderLogin({ redirectTo: '/create-video' });
    expect(screen.queryByText(RETURN_NOTE)).toBeNull();
  });
});

describe('the email form, in place', () => {
  it('turns the page into the form, with its own history entry, and focuses the field for a mouse', () => {
    setPointer(true);
    const pushState = vi.spyOn(window.history, 'pushState');
    renderLogin();

    fireEvent.click(within(choices()).getByRole('link', { name: 'Made an account with email? Sign in' }));

    expectShowing('email');
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0][0]).toMatchObject({ magicbookletSignInEmail: true });
    expect(pushState.mock.calls[0][2]).toBe('/login?returnUrl=%2Fcreate&email=1');
    expect(within(emailHalf()).getByLabelText('Email')).toHaveFocus();
  });

  it('lands a touch on the form’s title, so no keyboard rises as the page turns', () => {
    setPointer(false);
    renderLogin();

    fireEvent.click(within(choices()).getByRole('link', { name: 'Made an account with email? Sign in' }));

    expect(within(emailHalf()).getByRole('heading', { level: 1, name: 'Sign in with email' })).toHaveFocus();
  });

  it('leaves a click that asks for a new tab to the browser', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    renderLogin();

    const link = within(choices()).getByRole('link', { name: 'Made an account with email? Sign in' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
    expectShowing('choose');
  });

  it('turns back on X by stepping back over its entry, and on Escape, with focus on the way in', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {
      window.history.replaceState(null, '', '/login?returnUrl=%2Fcreate');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    renderLogin();
    const emailLink = within(choices()).getByRole('link', { name: 'Made an account with email? Sign in' });

    fireEvent.click(emailLink);
    expectShowing('email');
    fireEvent.click(within(emailHalf()).getByRole('button', { name: 'Back to all sign-in options' }));
    expectShowing('choose');
    expect(back).toHaveBeenCalledTimes(1);
    expect(emailLink).toHaveFocus();

    fireEvent.click(emailLink);
    expectShowing('email');
    fireEvent.keyDown(document, { key: 'Escape' });
    expectShowing('choose');
    expect(back).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe('?returnUrl=%2Fcreate');
  });

  it('follows the browser’s Back and Forward between the halves', () => {
    renderLogin();
    fireEvent.click(within(choices()).getByRole('link', { name: 'Made an account with email? Sign in' }));
    expectShowing('email');

    act(() => {
      window.history.replaceState(null, '', '/login?returnUrl=%2Fcreate');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expectShowing('choose');

    act(() => {
      window.history.replaceState({ magicbookletSignInEmail: true }, '', '/login?returnUrl=%2Fcreate&email=1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expectShowing('email');
  });

  it('opened on the form, puts the choices under it, so Back turns the page back as the app’s does', async () => {
    // The router's own state on the entry (`__NA`): both entries keep it, or Next reloads the
    // page on Forward onto the form (review of #744).
    window.history.replaceState({ __NA: true }, '', '/login?returnUrl=%2Fcreate&recovery=1');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');
    renderLogin({ initialHalf: 'email', recoveryRequested: true });

    expectShowing('email');
    // After the first commit, once the router owns the history API.
    expect(pushState).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(replaceState).toHaveBeenCalledWith({ __NA: true }, '', '/login?returnUrl=%2Fcreate');
    expect(pushState).toHaveBeenCalledWith({ __NA: true, magicbookletSignInEmail: true }, '', '/login?returnUrl=%2Fcreate&recovery=1&email=1');
  });

  it('opened on the form again (a reload), finds the choices under it already', () => {
    window.history.replaceState({ magicbookletSignInEmail: true }, '', '/login?returnUrl=%2Fcreate&email=1');
    const pushState = vi.spyOn(window.history, 'pushState');
    renderLogin({ initialHalf: 'email' });

    expectShowing('email');
    expect(pushState).not.toHaveBeenCalled();
  });

  it('turns back without an entry of its own by making this entry the choices’', () => {
    window.history.replaceState(null, '', '/login?returnUrl=%2Fcreate&email=1');
    // An entry the page did not push: e.g. the form reached through its own address in an older tab.
    vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    const back = vi.spyOn(window.history, 'back');
    renderLogin({ initialHalf: 'email' });

    fireEvent.click(within(emailHalf()).getByRole('button', { name: 'Back to all sign-in options' }));

    expectShowing('choose');
    expect(back).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?returnUrl=%2Fcreate');
  });

  // ?recovery=1 comes from an expired reset link (/auth/reset-password,
  // /auth/auth-code-error) and from older apps' "Forgot password?". It used to
  // ask for an email to send a fresh link that could never arrive.
  it('answers ?recovery=1 with the ways back in on the form, and drops it with the choices', async () => {
    await renderPageAt('returnUrl=%2Fcreate&recovery=1');

    expectShowing('email');
    const notice = within(emailHalf()).getByRole('status');
    expect(notice).toHaveTextContent(RECOVERY_NOTICE);
    expect(within(notice).getByRole('link', { name: siteConfig.supportEmail }))
      .toHaveAttribute('href', `mailto:${siteConfig.supportEmail}`);
    expect(screen.queryByText(/recovery link|reset link|choose forgot password/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /forgot password/i })).toBeNull();

    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    fireEvent.click(within(emailHalf()).getByRole('button', { name: 'Back to all sign-in options' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no recovery notice on an ordinary visit to the form', () => {
    renderLogin({ initialHalf: 'email' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/password reset emails/i)).toBeNull();
  });

  it('signs in with the password and goes on through /auth/continue', async () => {
    renderLogin({ initialHalf: 'email', redirectTo: '/create' });
    fillSignInForm();

    fireEvent.click(submitButton());

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'creator@example.com',
      password: 'Strong-password1!',
    }));
    expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('labels its fields for a password manager and holds the support line in place of a reset', () => {
    renderLogin({ initialHalf: 'email' });
    const form = within(emailHalf());

    expect(form.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(form.getByLabelText('Email')).toHaveAttribute('name', 'email');
    expect(form.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(form.getByLabelText('Password').closest('form')).toHaveAttribute('method', 'post');
    expect(screen.queryByText(/forgot password/i)).toBeNull();

    const supportLine = form.getByText(/^Trouble signing in\?/);
    expect(supportLine).toHaveTextContent(`Trouble signing in? Email ${siteConfig.supportEmail}`);
    expect(within(supportLine).getByRole('link', { name: siteConfig.supportEmail }))
      .toHaveAttribute('href', 'mailto:info@magicbooklet.com');
    expect(supportLine.closest('form')).not.toBeNull();

    fireEvent.click(form.getByRole('button', { name: 'Show password' }));
    expect(form.getByLabelText('Password')).toHaveAttribute('type', 'text');
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'a@b.c' } });
    fireEvent.click(form.getByRole('button', { name: 'Clear email' }));
    expect(form.getByLabelText('Email')).toHaveValue('');
  });

  // Audit 01-9: anything unrecognised printed Supabase's own text.
  it('words a failed sign-in for this site and never prints Supabase text', async () => {
    renderLogin({ initialHalf: 'email' });
    fillSignInForm();
    mocks.signInWithPassword.mockResolvedValueOnce({ error: new Error('Invalid login credentials') });
    fireEvent.click(submitButton());

    expect(await within(emailHalf()).findByRole('alert')).toHaveTextContent(
      'That email and password do not match. Check both and try again. If you created the account with Google or Apple, use that button instead.',
    );
    expect(mocks.replace).not.toHaveBeenCalled();

    mocks.signInWithPassword.mockResolvedValueOnce({ error: new Error('Database error querying schema') });
    fireEvent.click(submitButton());

    await waitFor(() => expect(within(emailHalf()).getByRole('alert')).toHaveTextContent('Could not sign in. Try again.'));
    expect(screen.queryByText(/database error/i)).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('holds the page while the password sign-in runs: no second sign-in, no turning back', async () => {
    let finish: (value: { error: null }) => void = () => undefined;
    mocks.signInWithPassword.mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve;
    }));
    const back = vi.spyOn(window.history, 'back');
    renderLogin({ initialHalf: 'email' });
    fillSignInForm();

    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton()).toHaveTextContent('Signing in…'));
    expect(submitButton()).toBeDisabled();
    expect(within(emailHalf()).getByRole('button', { name: 'Back to all sign-in options' })).toBeDisabled();
    expect(within(emailHalf()).getByRole('button', { name: 'Continue with Apple' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expectShowing('email');
    expect(back).not.toHaveBeenCalled();

    await act(async () => finish({ error: null }));
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate');
  });
});

describe('Apple and Google', () => {
  const originalAuthRedirectOrigin = process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
  });

  afterEach(() => {
    if (originalAuthRedirectOrigin === undefined) delete process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
    else process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = originalAuthRedirectOrigin;
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  // Apple is Supabase's web flow, finished by /auth/callback like Google's (the
  // runbook's "Sign in with Apple on the web").
  it('leave through the callback with the destination kept, from either half', async () => {
    const first = await renderPageAt('returnUrl=%2Fcreate-video');
    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Apple' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(providerRedirect().provider).toBe('apple');
    expect(providerRedirect().redirectTo.origin).toBe('https://magicbooklet.com');
    expect(providerRedirect().redirectTo.pathname).toBe('/auth/callback');
    expect(providerRedirect().redirectTo.searchParams.get('next')).toBe('/create-video');

    // A started sign-in leaves the page, so the form's Google is its own visit.
    first.unmount();
    await renderPageAt('returnUrl=%2Fcreate-video&email=1');
    fireEvent.click(within(emailHalf()).getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(2));
    expect(providerRedirect(1).provider).toBe('google');
    expect(providerRedirect(1).redirectTo.searchParams.get('next')).toBe('/create-video');
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  // The invite landing's "Create new account" opens /login?mode=signup&next=…
  // (src/app/r/[code]/ReferralLandingClient.tsx); the invite itself rides on a
  // cookie, so the link only has to land on Google and keep its destination.
  it('keep the invite landing’s link working: the same page, then Google with its destination', async () => {
    await renderPageAt('mode=signup&next=%2Fcreate');

    expectShowing('choose');
    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(providerRedirect().provider).toBe('google');
    expect(providerRedirect().redirectTo.searchParams.get('next')).toBe('/create');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  // The welcome-reward page sends a signed-out visitor to sign in and back to
  // the reward (src/app/welcome-reward/page.tsx).
  it('keep a nested return through Google and through a password', async () => {
    const welcomeRewardLink = `returnUrl=${encodeURIComponent('/welcome-reward?next=%2Fcreate')}`;
    const google = await renderPageAt(welcomeRewardLink);
    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(providerRedirect().redirectTo.searchParams.get('next')).toBe('/welcome-reward?next=%2Fcreate');

    google.unmount();
    await renderPageAt(`${welcomeRewardLink}&email=1`);
    fillSignInForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      `/auth/continue?next=${encodeURIComponent('/welcome-reward?next=%2Fcreate')}`,
    ));
  });

  it('hold every way in while one is starting', async () => {
    mocks.signInWithOAuth.mockReturnValueOnce(new Promise(() => undefined));
    renderLogin();
    const page = within(choices());

    fireEvent.click(page.getByRole('button', { name: 'Continue with Apple' }));

    await waitFor(() => expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeDisabled());
    expect(page.getByRole('button', { name: 'Continue with Apple' })).toHaveAttribute('aria-busy', 'true');
    expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
    expect(page.getByRole('link', { name: 'Made an account with email? Sign in' })).toHaveAttribute('aria-disabled', 'true');
    expect(page.getByRole('link', { name: 'Close' })).toHaveAttribute('aria-disabled', 'true');

    // Neither the form nor Close takes the page from under it.
    fireEvent.click(page.getByRole('link', { name: 'Made an account with email? Sign in' }));
    fireEvent.click(page.getByRole('link', { name: 'Close' }));
    expectShowing('choose');
    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1);
  });

  // auth-js builds the address and navigates, so a provider that is off shows its own
  // error page; what fails here is the start in this browser, such as storing the
  // PKCE verifier.
  it('name the provider when its sign-in cannot be started, and can be tried again', async () => {
    renderLogin();
    mocks.signInWithOAuth.mockRejectedValueOnce(new Error('The operation is insecure.'));

    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Apple' }));

    expect(await within(choices()).findByRole('alert')).toHaveTextContent('Could not start Apple sign-in. Try again.');
    expect(screen.queryByText(/insecure/i)).toBeNull();
    expect(within(choices()).getByRole('button', { name: 'Continue with Apple' })).toBeEnabled();

    mocks.signInWithOAuth.mockResolvedValueOnce({ error: new Error('Unsupported provider: provider is not enabled') });
    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(within(choices()).getByRole('alert')).toHaveTextContent('Could not start Google sign-in. Try again.'));
    expect(screen.queryByText(/unsupported provider/i)).toBeNull();
    expect(within(choices()).getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  });

  it('are usable again on a page the browser brings back after leaving for Apple', async () => {
    renderLogin();
    const apple = () => within(choices()).getByRole('button', { name: 'Continue with Apple' });

    fireEvent.click(apple());
    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(apple()).toBeDisabled();

    // Back from Apple's page: an ordinary pageshow changes nothing, a restored one does.
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    });
    expect(apple()).toBeDisabled();
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });

    expect(apple()).toBeEnabled();
    expect(within(choices()).getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    expect(submitButton()).toBeEnabled();
  });

  it('take an explicit auth redirect origin over the public site address', async () => {
    process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = 'https://www.magicbooklet.com';
    renderLogin();

    fireEvent.click(within(choices()).getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    expect(providerRedirect().redirectTo.origin).toBe('https://www.magicbooklet.com');
    expect(providerRedirect().redirectTo.pathname).toBe('/auth/callback');
  });
});

describe('leaving and passing through', () => {
  it('Close goes back to the page that sent the visitor here, on this site', () => {
    setNavigation(true);
    renderLogin({ redirectTo: '/showcase/post-1', returnRequested: true });

    fireEvent.click(within(choices()).getByRole('link', { name: 'Close' }));

    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('Close goes Home from a page opened fresh, or from another site', () => {
    setNavigation(false);
    renderLogin();

    fireEvent.click(within(choices()).getByRole('link', { name: 'Close' }));

    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/');
  });

  // Review of #744: a sign-out pushes /login with no return; a step back would redraw the last
  // page of the account that just left.
  it('Close goes Home, drawn fresh, when no page sent the visitor here (a sign-out)', () => {
    setNavigation(true);
    renderLogin();

    fireEvent.click(within(choices()).getByRole('link', { name: 'Close' }));

    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/');
  });

  it('Close goes to the page that sent the visitor here when there is no step back to it', () => {
    setNavigation(false);
    renderLogin({ redirectTo: '/showcase/post-1', returnRequested: true });

    fireEvent.click(within(choices()).getByRole('link', { name: 'Close' }));

    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/showcase/post-1');
  });

  // Review of #744: Back would reopen the creator's link, whose prompt and model win over the
  // draft the visitor edited; its return address leaves them out.
  it('Close takes a creator hand-over back to the creator’s own return address', () => {
    setNavigation(true);
    renderLogin({ redirectTo: '/create-video?handover=nonce-1', returnRequested: true });

    fireEvent.click(within(choices()).getByRole('link', { name: 'Close' }));

    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/create-video?handover=nonce-1');
  });

  // A visitor already signed in is sent on through /auth/continue, flagged so
  // that it is not counted as a new sign-in there.
  it('sends a visitor who is already signed in on, flagged as no new sign-in', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    renderLogin({ redirectTo: '/create' });

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate&signedIn=1'));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });
});

// The server's HTML draws the form before the page's script runs, and what goes into it then
// reaches no React: React hydrated the fields without reading them back, and a sign-in sent an
// empty email and password (2026-11-01; tests/e2e/login-typed-before-script.spec.ts).
describe('a sign-in form the browser filled before the page’s script ran', () => {
  const EMAIL = 'early-visitor@example.com';
  const PASSWORD = 'typed-before-the-script-5150';
  const recoverableErrors: unknown[] = [];

  beforeEach(() => {
    mocks.signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
    window.history.replaceState({ magicbookletSignInEmail: true }, '', '/login?redirect=%2Fcreate-image&email=1');
  });

  afterEach(() => {
    // The form hydrated: React never drew it again on the client, which would drop the text.
    expect(recoverableErrors.splice(0)).toEqual([]);
  });

  /** Typing into the server's HTML: an input event no React hears. */
  function typeInto(field: HTMLInputElement, text: string) {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * The page's server HTML, filled by `fill` before any script runs, then hydrated. Testing
   * Library's cleanup unmounts the root and removes the container.
   */
  function hydrateAfter(fill: (email: HTMLInputElement, password: HTMLInputElement) => void) {
    const page = <LoginClient initialHalf="email" recoveryRequested={false} redirectTo="/create-image" welcomeCredits={25} />;
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    document.body.appendChild(container);
    fill(container.querySelector('#login-email')!, container.querySelector('#login-password')!);
    render(page, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
    return {
      email: container.querySelector<HTMLInputElement>('#login-email')!,
      password: container.querySelector<HTMLInputElement>('#login-password')!,
      submit: () => act(async () => {
        fireEvent.submit(container.querySelector('form')!);
      }),
    };
  }

  it('signs in with what was typed, and the fields keep it', async () => {
    const form = hydrateAfter((email, password) => {
      typeInto(email, EMAIL);
      typeInto(password, PASSWORD);
    });

    await form.submit();

    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(screen.getByRole('alert')).toHaveTextContent('That email and password do not match.');
    expect(form.email.value).toBe(EMAIL);
    expect(form.password.value).toBe(PASSWORD);
  });

  it('signs in with an email put in with no input event before the script, and a password typed after it', async () => {
    const form = hydrateAfter((email) => {
      email.value = EMAIL;
    });
    fireEvent.change(form.password, { target: { value: PASSWORD } });

    await form.submit();

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(form.email.value).toBe(EMAIL);
  });
});
