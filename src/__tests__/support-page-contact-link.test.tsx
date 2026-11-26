import { render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authState } = vi.hoisted(() => ({
  authState: {
    session: null as { access_token: string; user: { id: string; is_anonymous: boolean } } | null,
    user: null as { id: string; is_anonymous: boolean } | null,
  },
}));

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => authState }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('@/components/support-chat/use-support-chat', () => ({
  useSupportChat: () => ({ state: { kind: 'registration-required' }, reload: vi.fn(async () => undefined) }),
}));
vi.mock('@/components/support-chat/SupportChat', () => ({ SupportChat: () => null }));

import SupportHubClient from '@/app/support/SupportHubClient';

describe('the support page', () => {
  beforeEach(() => {
    authState.session = null;
    authState.user = null;
  });

  // The shell's "Help & feedback" opens this page for everyone (owner, 2026-11-26), and the
  // contact page holds the only links such a visitor sees to child safety and account deletion,
  // so this page leads there: for a visitor with no session, and for a guest, whom the chat's
  // routes answer REGISTRATION_REQUIRED.
  it.each([
    ['a visitor', null],
    ['a guest', { id: 'guest-1', is_anonymous: true }],
  ] as const)('links the contact page beside the support email for %s', (_reader, user) => {
    authState.user = user ? { ...user } : null;
    authState.session = user ? { access_token: 'token-1', user: { ...user } } : null;
    render(<SupportHubClient initialTab="chat" />);

    expect(screen.getByRole('heading', { name: 'Sign in to message support' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'info@magicbooklet.com' })).toHaveAttribute('href', expect.stringMatching(/^mailto:info@magicbooklet\.com\?/));
    expect(screen.getByRole('link', { name: 'contact page' })).toHaveAttribute('href', '/contact');
  });
});
