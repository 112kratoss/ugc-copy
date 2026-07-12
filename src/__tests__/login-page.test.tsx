import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from '@/app/login/page';

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
  useSearchParams: () => mocks.searchParams,
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

  it('keeps normal login pointed at the requested return URL', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    render(<LoginPage />);

    fillAuthForm();
    fireEvent.click(screen.getAllByRole('button', { name: /^sign in$/i }).at(-1)!);

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith('/auth/continue?next=%2Fcreate');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('sends password recovery back through the authenticated reset page', async () => {
    render(<LoginPage />);

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
    render(<LoginPage />);

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
    render(<LoginPage />);

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
    render(<LoginPage />);

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

  it('does not advertise Apple while the provider is unavailable', () => {
    render(<LoginPage />);

    expect(screen.queryByRole('button', { name: /apple/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
  });

  it('shows and enforces the configured password requirements before signup', async () => {
    render(<LoginPage />);

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
    render(<LoginPage />);

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
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /google/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const oauthPayload = mocks.signInWithOAuth.mock.calls[0][0];
    const redirectTo = new URL(oauthPayload.options.redirectTo);

    expect(oauthPayload.provider).toBe('google');
    expect(redirectTo.origin).toBe('https://www.magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
  });
});
