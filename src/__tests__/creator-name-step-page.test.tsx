import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cookie: vi.fn<() => string | undefined>(),
  hint: vi.fn(async () => true),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: (url: string) => mocks.redirect(url) }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => {
    const value = mocks.cookie();
    return value === undefined ? undefined : { value };
  } }),
}));
vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => mocks.auth(),
  getServerPublicIdentity: (auth: { username?: string | null; displayName?: string | null }) => (
    auth.username === undefined ? null : { username: auth.username, displayName: auth.displayName ?? null }
  ),
}));
vi.mock('@/components/RouteAuthBoundary', () => ({ requestHasAuthHint: () => mocks.hint() }));
vi.mock('@/app/onboarding/CreatorNameStep', () => ({
  default: (props: { nextPath: string; userId: string; savedUsername: string | null; start: { displayName: string; username: string } }) => (
    <div
      data-testid="creator-name-step"
      data-next={props.nextPath}
      data-user={props.userId}
      data-saved={props.savedUsername ?? ''}
      data-name={props.start.displayName}
      data-handle={props.start.username}
    />
  ),
}));

import CreatorNameStepPage from '@/app/onboarding/page';
import { reopenCreatorNameStepFromHome } from '@/lib/creator-name-step-server';

const USER = { id: 'user-1', email: 'kiran@example.com', is_anonymous: false, user_metadata: { full_name: 'Kiran Das' } };

function signedIn(profile: { username?: string | null; displayName?: string | null } = { username: 'creator-a1b2c3d4', displayName: null }, user: Record<string, unknown> = USER) {
  mocks.auth.mockResolvedValue({ session: { user }, credits: 0, ...profile });
}

describe('/onboarding', () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.redirect.mockClear();
  });

  it('sends a signed-out visitor to sign in and back to the step, next kept', async () => {
    mocks.auth.mockResolvedValue({ session: null, credits: null });

    await expect(CreatorNameStepPage({ searchParams: Promise.resolve({ next: '/create-video?handover=nonce-1234' }) }))
      .rejects.toThrow('NEXT_REDIRECT:/login?returnUrl=%2Fonboarding%3Fnext%3D%252Fcreate-video%253Fhandover%253Dnonce-1234');
  });

  it('sends a guest to sign in: a guest has no creator name to claim', async () => {
    signedIn(undefined, { ...USER, is_anonymous: true });

    await expect(CreatorNameStepPage({ searchParams: Promise.resolve({ next: '/' }) }))
      .rejects.toThrow('NEXT_REDIRECT:/login?returnUrl=%2Fonboarding%3Fnext%3D%252F');
  });

  it('sends an account that already has its name and handle straight on to next', async () => {
    signedIn({ username: 'kiran-das', displayName: 'Kiran Das' });

    await expect(CreatorNameStepPage({ searchParams: Promise.resolve({ next: '/create-image?model=gpt-image-2' }) }))
      .rejects.toThrow(/^NEXT_REDIRECT:\/create-image\?model=gpt-image-2$/);
  });

  it('draws the step for an account without a creator name, suggested handle and all', async () => {
    signedIn();

    render(await CreatorNameStepPage({ searchParams: Promise.resolve({ next: '/create-video?handover=nonce-1234' }) }));

    const step = screen.getByTestId('creator-name-step');
    expect(step).toHaveAttribute('data-next', '/create-video?handover=nonce-1234');
    expect(step).toHaveAttribute('data-user', 'user-1');
    expect(step).toHaveAttribute('data-saved', 'creator-a1b2c3d4');
    expect(step).toHaveAttribute('data-name', 'Kiran Das');
    expect(step).toHaveAttribute('data-handle', 'kiran-das');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('keeps an unsafe or missing next to the default, and never opens itself again', async () => {
    signedIn();

    render(await CreatorNameStepPage({ searchParams: Promise.resolve({ next: '//attacker.example' }) }));
    expect(screen.getByTestId('creator-name-step')).toHaveAttribute('data-next', '/create');

    signedIn({ username: 'kiran-das', displayName: 'Kiran Das' });
    await expect(CreatorNameStepPage({ searchParams: Promise.resolve({ next: '/onboarding?next=%2Fcreations' }) }))
      .rejects.toThrow(/^NEXT_REDIRECT:\/creations$/);
  });
});

describe('Home opening the step again', () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.redirect.mockClear();
    mocks.cookie.mockReset();
    mocks.hint.mockReset();
    mocks.hint.mockResolvedValue(true);
  });

  it('sends an account without a creator name to the step, which comes back to Home', async () => {
    signedIn();

    await expect(reopenCreatorNameStepFromHome()).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\?next=%2F$/);
  });

  it('opens it once per browser session for that account', async () => {
    signedIn();
    mocks.cookie.mockReturnValue('user-1');
    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();

    // Shown in this session for another account only.
    mocks.cookie.mockReturnValue('user-2');
    await expect(reopenCreatorNameStepFromHome()).rejects.toThrow(/NEXT_REDIRECT:\/onboarding/);
  });

  it('leaves a named account, an earlier "Set up later", a guest and an unread profile on Home', async () => {
    signedIn({ username: 'kiran-das', displayName: 'Kiran Das' });
    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();

    signedIn(undefined, { ...USER, user_metadata: { creator_profile_onboarding_skipped_version: 1 } });
    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();

    signedIn(undefined, { ...USER, is_anonymous: true });
    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();

    // The E2E bypass's session reads no profile row: nothing is decided.
    mocks.auth.mockResolvedValue({ session: { user: USER }, credits: 0 });
    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('reads nothing for a request with no sign-in cookie', async () => {
    mocks.hint.mockResolvedValue(false);

    await expect(reopenCreatorNameStepFromHome()).resolves.toBeUndefined();
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
