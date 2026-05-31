import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginPage from '@/app/login/page';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  getSession: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
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
    mocks.signUp.mockReset();
    mocks.getSession.mockReset();
    mocks.searchParams = new URLSearchParams();
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.signInWithPassword.mockResolvedValue({ error: null });
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

  function fillAuthForm() {
    fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
      target: { value: 'creator@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'strong-password' },
    });
  }

  it('keeps normal login pointed at the requested return URL', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    render(<LoginPage />);

    fillAuthForm();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith('/create');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('sends immediate email signups to creator profile setup instead of the requested app route', async () => {
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
    expect(emailRedirectTo.searchParams.get('next')).toBe('/profile?welcome=1');
    expect(mocks.replace).toHaveBeenCalledWith('/profile?welcome=1');
    expect(mocks.replace).not.toHaveBeenCalledWith('/create');
  });

  it('configures confirmation-email signups to return to profile setup', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fillAuthForm();
    fireEvent.click(screen.getByRole('button', { name: /^create account$/i }));

    await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
    const signUpPayload = mocks.signUp.mock.calls[0][0];
    const emailRedirectTo = new URL(signUpPayload.options.emailRedirectTo);

    expect(emailRedirectTo.origin).toBe('https://magicbooklet.com');
    expect(emailRedirectTo.searchParams.get('next')).toBe('/profile?welcome=1');
    expect(
      await screen.findByText(/it will open your creator profile setup automatically/i)
    ).toBeInTheDocument();
  });

  it('uses profile setup as the Google target when the user is in signup mode', async () => {
    mocks.searchParams = new URLSearchParams('returnUrl=/create');
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^google$/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const oauthPayload = mocks.signInWithOAuth.mock.calls[0][0];
    const redirectTo = new URL(oauthPayload.options.redirectTo);

    expect(redirectTo.origin).toBe('https://magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/profile?welcome=1');
  });

  it('allows an explicit auth redirect origin to override the public site URL', async () => {
    process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN = 'https://www.magicbooklet.com';
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /^google$/i }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalled());
    const oauthPayload = mocks.signInWithOAuth.mock.calls[0][0];
    const redirectTo = new URL(oauthPayload.options.redirectTo);

    expect(redirectTo.origin).toBe('https://www.magicbooklet.com');
    expect(redirectTo.pathname).toBe('/auth/callback');
  });
});
