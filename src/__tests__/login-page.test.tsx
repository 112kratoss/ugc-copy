import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginClient from '@/app/login/LoginClient';
import LoginPage from '@/app/login/page';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import { siteConfig } from '@/lib/seo';

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return {
    replace,
    refresh,
    // One router object for every render: a fresh one each time re-runs the
    // page's session effect on every render.
    router: { replace, refresh },
    getSession: vi.fn(),
    signInWithOAuth: vi.fn(),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    signUp: vi.fn(),
    searchParams: new URLSearchParams(),
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
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      signUp: mocks.signUp,
    },
  },
}));

const AGREEMENT = 'By continuing you agree to the Terms and the Privacy Policy. Prompts and media you generate are processed by the AI providers listed in the policy.';
const RECOVERY_NOTICE = 'Password reset emails aren’t available. Signed up with Google? Use Continue with Google. Otherwise, email info@magicbooklet.com and we’ll help you sign in.';

describe('LoginPage onboarding redirects', () => {
  const originalAuthRedirectOrigin = process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.refresh.mockClear();
    mocks.signInWithOAuth.mockReset();
    mocks.signInWithPassword.mockReset();
    mocks.resetPasswordForEmail.mockReset();
    mocks.signUp.mockReset();
    mocks.getSession.mockReset();
    mocks.searchParams = new URLSearchParams();
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.signInWithPassword.mockResolvedValue({ error: null });
    mocks.resetPasswordForEmail.mockResolvedValue({ error: null });
    mocks.signInWithOAuth.mockResolvedValue({ error: null });
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
    delete process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
  });

  afterEach(() => {
    if (originalAuthRedirectOrigin === undefined) {
      delete process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN;
    } else {
      process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = originalAuthRedirectOrigin;
    }

    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
  });

  function fillSignInForm() {
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'Strong-password1!' },
    });
  }

  // The tab and the form's submit button are both named "Sign in".
  function signInSubmitButton() {
    const submit = screen.getAllByRole('button', { name: /^sign in$/i })
      .find((button) => button.getAttribute('type') === 'submit');
    if (!submit) throw new Error('No Sign in submit button');
    return submit;
  }

  function renderLogin() {
    const explicitRedirect = mocks.searchParams.get('next')
      || mocks.searchParams.get('redirect')
      || mocks.searchParams.get('returnUrl');

    return render(
      <LoginClient
        initialMode={mocks.searchParams.get('mode') === 'signup' ? 'signup' : 'login'}
        recoveryRequested={mocks.searchParams.get('recovery') === '1'}
        redirectTo={getSafeAuthNextPath(explicitRedirect)}
      />
    );
  }

  // Opens the page the way a link does: the server component reads the query,
  // then renders the client with what it resolved.
  async function renderPageAt(query: string) {
    return render(await LoginPage({
      searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(query))),
    }));
  }

  function googleRedirect(callIndex = 0) {
    const payload = mocks.signInWithOAuth.mock.calls[callIndex][0];
    return { provider: payload.provider, redirectTo: new URL(payload.options.redirectTo) };
  }

  it('resolves query intent on the server so the real form is present in initial HTML', async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({
        mode: 'signup',
        recovery: '1',
        returnUrl: '/create',
      }),
    });

    expect(element.type).toBe(LoginClient);
    expect(element.props).toMatchObject({
      initialMode: 'signup',
      recoveryRequested: true,
      redirectTo: '/create',
    });
  });

  it('keeps normal login pointed at the requested return URL', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    renderLogin();

    fillSignInForm();
    fireEvent.click(signInSubmitButton());

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'creator@example.com',
      password: 'Strong-password1!',
    }));
    expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  // A visitor already signed in is sent on through /auth/continue, flagged so
  // that it is not counted as a new sign-in there.
  it('sends a visitor who is already signed in on, flagged as no new sign-in', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } });
    renderLogin();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate&signedIn=1'));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  // D2 (OAuth-first): production refuses every email sign-up, so the form that
  // ended in that refusal is gone; new accounts are made with Google.
  it('has no email sign-up: the Sign-up tab is Google, the agreement and a sentence saying so', () => {
    const { container } = renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));

    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByText('New accounts are created with Google. Your creator profile comes next.')).toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /create account/i })).toBeNull();
    expect(screen.queryByText(/or continue with/i)).toBeNull();
    expect(screen.queryByText(/your password needs/i)).toBeNull();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /continue with google/i })).toHaveAccessibleDescription(AGREEMENT);
    expect(mocks.signUp).not.toHaveBeenCalled();

    // The Sign-in tab keeps email and password for the accounts made before.
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByText(/or continue with/i)).toBeInTheDocument();
  });

  // The invite landing's "Create new account" opens /login?mode=signup&next=…
  // (src/app/r/[code]/ReferralLandingClient.tsx); the invite itself rides on a
  // cookie, so the link only has to land on Google and keep its destination.
  it('keeps the invite landing link working: the Sign-up tab, then Google with its destination', async () => {
    await renderPageAt('mode=signup&next=%2Fcreate');

    expect(screen.getByRole('button', { name: /^sign up$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    const { provider, redirectTo } = googleRedirect();
    expect(provider).toBe('google');
    expect(redirectTo.origin).toBe('https://magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/create');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  // The welcome-reward page sends a signed-out visitor to sign in and back to
  // the reward (src/app/welcome-reward/page.tsx).
  it('keeps the welcome-reward sign-in link working through Google and through a password', async () => {
    const welcomeRewardLink = `returnUrl=${encodeURIComponent('/welcome-reward?next=%2Fcreate')}`;
    const google = await renderPageAt(welcomeRewardLink);

    expect(screen.getByRole('button', { name: /^sign in$/i, pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(googleRedirect().redirectTo.searchParams.get('next')).toBe('/welcome-reward?next=%2Fcreate');

    // A started Google sign-in leaves the page, so the password path is its own visit.
    google.unmount();
    await renderPageAt(welcomeRewardLink);
    fillSignInForm();
    fireEvent.click(signInSubmitButton());
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      `/auth/continue?next=${encodeURIComponent('/welcome-reward?next=%2Fcreate')}`,
    ));
  });

  it('preserves intent for Google while server-side onboarding decides the destination', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fireEvent.click(screen.getByRole('button', { name: /google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const { provider, redirectTo } = googleRedirect();

    expect(provider).toBe('google');
    expect(redirectTo.origin).toBe('https://magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/create');
  });

  // D2: no mail sender can deliver a reset link, so "Forgot password?" sent
  // nothing; a locked-out password account is recovered through support.
  it('offers no password reset, and the support address in its place', () => {
    renderLogin();

    expect(screen.queryByRole('button', { name: /forgot password/i })).toBeNull();
    expect(screen.queryByText(/forgot password/i)).toBeNull();

    const supportLine = screen.getByText(/^Trouble signing in\?/);
    expect(supportLine).toHaveTextContent(`Trouble signing in? Email ${siteConfig.supportEmail}`);
    expect(within(supportLine).getByRole('link', { name: siteConfig.supportEmail }))
      .toHaveAttribute('href', 'mailto:info@magicbooklet.com');
    expect(supportLine.closest('form')).not.toBeNull();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  // ?recovery=1 comes from an expired reset link (/auth/reset-password,
  // /auth/auth-code-error) and from older apps' "Forgot password?". It used to
  // ask for an email to send a fresh link that could never arrive.
  it('answers ?recovery=1 with the ways back in, not a reset prompt', () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create&recovery=1');
    renderLogin();

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(RECOVERY_NOTICE);
    expect(within(notice).getByRole('link', { name: siteConfig.supportEmail }))
      .toHaveAttribute('href', `mailto:${siteConfig.supportEmail}`);
    expect(screen.queryByText(/recovery link|reset link|choose forgot password/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /forgot password/i })).toBeNull();

    // It opens on the Sign-in tab with the form, and Google keeps the return path.
    expect(screen.getByRole('button', { name: /^sign in$/i, pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('shows no recovery notice on an ordinary visit', () => {
    renderLogin();

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/password reset emails/i)).toBeNull();
  });

  function expectAgreementLinks(agreement: HTMLElement) {
    expect(agreement).toHaveTextContent(AGREEMENT);
    expect(within(agreement).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(within(agreement).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(within(agreement).getByRole('link', { name: 'listed in the policy' })).toHaveAttribute('href', '/privacy#ai-processing');
  }

  // Audit 01-6: Google creates accounts from the Sign-in tab too, where no
  // agreement line was shown, so most new web accounts never saw one. With the
  // email form gone, Google is the only way to make an account, in either tab.
  it('puts the terms and the AI-processing sentence under the Google button in both tabs', () => {
    renderLogin();

    const signInAgreements = screen.getAllByText(/By continuing you agree to the/);
    expect(signInAgreements).toHaveLength(1);
    expect(signInAgreements[0]).toHaveAttribute('id', 'google-agreement');
    expectAgreementLinks(signInAgreements[0]);
    expect(screen.getByRole('button', { name: /continue with google/i })).toHaveAccessibleDescription(AGREEMENT);

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));

    const signUpAgreements = screen.getAllByText(/By continuing you agree to the/);
    expect(signUpAgreements).toHaveLength(1);
    expect(signUpAgreements[0]).toHaveAttribute('id', 'google-agreement');
    expectAgreementLinks(signUpAgreements[0]);
    expect(screen.getByRole('button', { name: /continue with google/i })).toHaveAccessibleDescription(AGREEMENT);
  });

  // Audit 01-9: anything unrecognised printed Supabase's own text.
  it('words a failed sign-in for this site and never prints Supabase text', async () => {
    renderLogin();
    fillSignInForm();
    mocks.signInWithPassword.mockResolvedValueOnce({ error: new Error('Invalid login credentials') });
    fireEvent.click(signInSubmitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email and password do not match. Check both and try again, or use Google if you signed up with it.',
    );
    expect(mocks.replace).not.toHaveBeenCalled();

    mocks.signInWithPassword.mockResolvedValueOnce({ error: new Error('Database error querying schema') });
    fireEvent.click(signInSubmitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not sign in. Try again.'));
    expect(screen.queryByText(/database error/i)).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  // On the Sign-up tab the Google button is the only action, so a failed start
  // is said there rather than inside a form that tab no longer draws.
  it('shows a failed Google start on the Sign-up tab and lets it be tried again', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    mocks.signInWithOAuth.mockResolvedValueOnce({ error: new Error('Unsupported provider: provider is not enabled') });

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start Google sign-in. Try again.');
    expect(screen.queryByText(/unsupported provider/i)).toBeNull();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();

    // Switching tabs clears it.
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not advertise Apple while the provider is unavailable', () => {
    renderLogin();

    expect(screen.queryByRole('button', { name: /apple/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    expect(screen.queryByRole('button', { name: /apple/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/apple/i)).toBeNull();
  });

  it('allows an explicit auth redirect origin to override the public site URL', async () => {
    process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = 'https://www.magicbooklet.com';
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const { provider, redirectTo } = googleRedirect();

    expect(provider).toBe('google');
    expect(redirectTo.origin).toBe('https://www.magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
  });
});
