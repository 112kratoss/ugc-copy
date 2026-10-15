import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginClient from '@/app/login/LoginClient';
import LoginPage from '@/app/login/page';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  getSession: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signUp: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
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

  function fillAuthForm(password = 'Strong-password1!') {
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: password },
    });
    const confirmation = screen.queryByLabelText(/confirm password/i);
    if (confirmation) {
      fireEvent.change(confirmation, { target: { value: password } });
    }
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

    fillAuthForm();
    fireEvent.click(screen.getAllByRole('button', { name: /^sign in$/i }).at(-1)!);

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalled());
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

  it('sends password recovery back through the authenticated reset page', async () => {
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));

    await waitFor(() => expect(mocks.resetPasswordForEmail).toHaveBeenCalled());
    const [, options] = mocks.resetPasswordForEmail.mock.calls[0];
    const redirectTo = new URL(options.redirectTo);

    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/auth/reset-password?next=%2Fcreate');
    expect(await screen.findByText(/password reset link sent/i)).toBeInTheDocument();
  });

  it('sends immediate email signups through server auth finalization before profile setup', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    mocks.signUp.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fillAuthForm();
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
    const signUpPayload = mocks.signUp.mock.calls[0][0];
    const emailRedirectTo = new URL(signUpPayload.options.emailRedirectTo);

    expect(emailRedirectTo.pathname).toBe('/auth/callback');
    expect(emailRedirectTo.origin).toBe('https://magicbooklet.com');
    expect(emailRedirectTo.searchParams.get('next')).toBe('/create');
    expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate');
    expect(mocks.replace).not.toHaveBeenCalledWith('/create');
  });

  it('preserves the requested route through confirmation-email signup', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create/video?model=kling');
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fillAuthForm();
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
    const signUpPayload = mocks.signUp.mock.calls[0][0];
    const emailRedirectTo = new URL(signUpPayload.options.emailRedirectTo);

    expect(emailRedirectTo.origin).toBe('https://magicbooklet.com');
    expect(emailRedirectTo.searchParams.get('next')).toBe('/create/video?model=kling');
    expect(
      await screen.findByText(/continue where you left off/i)
    ).toBeInTheDocument();
  });

  it('preserves intent for Google while server-side onboarding decides the destination', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fireEvent.click(screen.getByRole('button', { name: /google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const oauthPayload = mocks.signInWithOAuth.mock.calls[0][0];
    const redirectTo = new URL(oauthPayload.options.redirectTo);

    expect(oauthPayload.provider).toBe('google');
    expect(redirectTo.origin).toBe('https://magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/create');
  });

  const AGREEMENT = 'By continuing you agree to the Terms and the Privacy Policy. Prompts and media you generate are processed by the AI providers listed in the policy.';

  function expectAgreementLinks(agreement: HTMLElement) {
    expect(agreement).toHaveTextContent(AGREEMENT);
    expect(within(agreement).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(within(agreement).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    expect(within(agreement).getByRole('link', { name: 'listed in the policy' })).toHaveAttribute('href', '/privacy#ai-processing');
  }

  // Web sign-up had no agreement line, and never said where prompts go.
  it('puts the terms and the AI-processing sentence under the sign-up button', () => {
    renderLogin();
    expect(screen.queryByRole('button', { name: /^create account$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));

    const [signUpAgreement] = screen.getAllByText(/By continuing you agree to the/);
    expect(signUpAgreement).toHaveAttribute('id', 'signup-agreement');
    expectAgreementLinks(signUpAgreement);
    expect(screen.getByRole('button', { name: /^create account$/i })).toHaveAccessibleDescription(AGREEMENT);
  });

  // Audit 01-6: Google creates accounts from the Sign-in tab too, where no
  // agreement line was shown, so most new web accounts never saw one.
  it('puts the terms and the AI-processing sentence under the Google button in both tabs', () => {
    renderLogin();

    const signInAgreements = screen.getAllByText(/By continuing you agree to the/);
    expect(signInAgreements).toHaveLength(1);
    expectAgreementLinks(signInAgreements[0]);
    expect(screen.getByRole('button', { name: /continue with google/i })).toHaveAccessibleDescription(AGREEMENT);

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));

    const signUpAgreements = screen.getAllByText(/By continuing you agree to the/);
    expect(signUpAgreements).toHaveLength(2);
    expectAgreementLinks(signUpAgreements[1]);
    expect(screen.getByRole('button', { name: /continue with google/i })).toHaveAccessibleDescription(AGREEMENT);
  });

  // Audit 01-9: the sign-up hook's refusal names Apple, which the web lacks,
  // and anything unrecognised printed Supabase's own text.
  it('words a refused email sign-up for this site and never prints Supabase text', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fillAuthForm();
    mocks.signUp.mockResolvedValueOnce({
      data: { session: null },
      error: new Error('Email sign-up is temporarily unavailable. Continue with Google or Apple.'),
    });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email sign-up is temporarily unavailable. Continue with Google.');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/apple/i);

    mocks.signUp.mockResolvedValueOnce({
      data: { session: null },
      error: new Error('Error sending confirmation email'),
    });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not create the account. Try again.'));
    expect(screen.queryByText(/confirmation email/i)).toBeNull();
  });

  it('does not advertise Apple while the provider is unavailable', () => {
    renderLogin();

    expect(screen.queryByRole('button', { name: /apple/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('shows and enforces the configured password requirements before signup', async () => {
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    expect(screen.getByText('8 or more characters')).toBeInTheDocument();
    expect(screen.getByText('One lowercase letter')).toBeInTheDocument();
    expect(screen.getByText('One uppercase letter')).toBeInTheDocument();
    expect(screen.getByText('One number')).toBeInTheDocument();
    expect(screen.getByText('One symbol')).toBeInTheDocument();

    fillAuthForm('alllowercase');
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/uppercase letter.*number.*symbol/i);
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^password$/i)).toHaveFocus();
  });

  it('requires password confirmation before creating an account', async () => {
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fillAuthForm();
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'Different-password1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passwords do not match/i);
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/confirm password/i)).toHaveFocus();
  });

  it('allows an explicit auth redirect origin to override the public site URL', async () => {
    process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = 'https://www.magicbooklet.com';
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const oauthPayload = mocks.signInWithOAuth.mock.calls[0][0];
    const redirectTo = new URL(oauthPayload.options.redirectTo);

    expect(oauthPayload.provider).toBe('google');
    expect(redirectTo.origin).toBe('https://www.magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
  });
});
