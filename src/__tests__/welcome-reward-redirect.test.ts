import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to });
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: async () => ({ session: harness.session }),
}));

import WelcomeRewardPage from '@/app/welcome-reward/page';
import { welcomeRewardDestination, welcomeRewardSignInReturn } from '@/lib/welcome-reward-redirect';

async function landing(params: Record<string, string>) {
  try {
    await WelcomeRewardPage({ searchParams: Promise.resolve(params) });
  } catch (error) {
    return (error as { to?: string }).to;
  }
  throw new Error('no redirect');
}

describe('the old welcome page (the credits are the popup’s now, owner 11-09)', () => {
  beforeEach(() => {
    harness.session = { user: { id: 'user-1' } };
  });

  it('sends a signed-in account on to its next page, marked as the page a sign-up returned to', async () => {
    expect(await landing({ next: '/create' })).toBe('/create?welcome=1');
    expect(await landing({ next: '/' })).toBe('/?welcome=1');
    expect(await landing({ next: '/showcase?chip=new' })).toBe('/showcase?chip=new&welcome=1');
  });

  it('carries the invite’s outcome it was given, and nothing that is not one', async () => {
    expect(await landing({ next: '/create', referral: 'applied' })).toBe('/create?welcome=1&referral=applied');
    expect(await landing({ next: '/create', referral: '<x>' })).toBe('/create?welcome=1');
  });

  it('keeps an outside or missing next to the creators, as the page did', async () => {
    expect(await landing({ next: 'https://evil.example/x' })).toBe('/create?welcome=1');
    expect(await landing({ next: '//evil.example' })).toBe('/create?welcome=1');
    expect(await landing({})).toBe('/create?welcome=1');
  });

  it('has a visitor sign in first and come back to it', async () => {
    harness.session = null;
    expect(await landing({ next: '/', referral: 'applied' }))
      .toBe(`/login?returnUrl=${encodeURIComponent('/welcome-reward?next=%2F&referral=applied')}`);
  });

  it('builds its two addresses in one place', () => {
    expect(welcomeRewardDestination('/create-video', null)).toBe('/create-video?welcome=1');
    expect(welcomeRewardSignInReturn('/create', undefined)).toBe('/welcome-reward?next=%2Fcreate');
  });
});
