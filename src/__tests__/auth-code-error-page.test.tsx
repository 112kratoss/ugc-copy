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
