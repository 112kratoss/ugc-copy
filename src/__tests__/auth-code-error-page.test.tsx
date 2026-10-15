import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthCodeErrorPage from '@/app/auth/auth-code-error/page';

describe('AuthCodeErrorPage', () => {
  it('preserves the requested destination in the sign-in retry', async () => {
    render(await AuthCodeErrorPage({
      searchParams: Promise.resolve({ next: '/create/video?model=kling' }),
    }));

    expect(screen.getByRole('link', { name: /try sign in again/i })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fcreate%2Fvideo%3Fmodel%3Dkling'
    );
  });

  // Audit 01-9: /auth/continue follows a password sign-in, where no link was involved.
  it('does not blame a link when a password sign-in could not be finished', async () => {
    render(await AuthCodeErrorPage({
      searchParams: Promise.resolve({ next: '/pricing', method: 'password' }),
    }));

    expect(screen.getByRole('heading', { name: 'We could not finish signing you in' })).toBeInTheDocument();
    expect(screen.getByText('Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/link/i)).toBeNull();
    expect(screen.getByRole('link', { name: /try sign in again/i })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fpricing'
    );
  });

  it('keeps the link advice for a sign-in that came through a link', async () => {
    render(await AuthCodeErrorPage({
      searchParams: Promise.resolve({ next: '/pricing' }),
    }));

    expect(screen.getByRole('heading', { name: 'We could not finish signing you in' })).toBeInTheDocument();
    expect(screen.getByText(/The sign-in link may have expired/)).toBeInTheDocument();
  });

  it('unwraps the final destination when requesting a replacement recovery link', async () => {
    render(await AuthCodeErrorPage({
      searchParams: Promise.resolve({
        next: '/auth/reset-password?next=%2Fcreate%2Fimage',
      }),
    }));

    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fcreate%2Fimage&recovery=1'
    );
  });
});
