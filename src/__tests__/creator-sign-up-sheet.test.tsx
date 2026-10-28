import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithOAuth: vi.fn(async () => ({ data: {}, error: null as Error | null })),
  markVisitorDraftForHandover: vi.fn((): string | null => 'nonce-test-1234'),
  calls: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithOAuth: mocks.signInWithOAuth } },
}));

vi.mock('@/lib/creator-visitor-draft', () => ({
  markVisitorDraftForHandover: mocks.markVisitorDraftForHandover,
}));

import CreatorSignUpSheet, { creatorSignUpBody } from '@/components/CreatorSignUpSheet';

function renderSheet(overrides: Partial<Parameters<typeof CreatorSignUpSheet>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <CreatorSignUpSheet
      reason="generate"
      tool="video"
      handsOverDraft
      welcomeCredits={25}
      runCost={19}
      modelName="Seedance 2 Mini"
      settingsSummary="480P · 9:16 · 5s"
      keepsPrompt
      keepsImages
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose, view };
}

function redirectNext() {
  const [[{ options }]] = mocks.signInWithOAuth.mock.calls as unknown as [[{ options: { redirectTo: string } }]];
  return new URL(options.redirectTo).searchParams.get('next');
}

describe('the sign-up a visitor meets at Generate', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.push.mockReset();
    mocks.signInWithOAuth.mockReset();
    mocks.signInWithOAuth.mockImplementation(async () => {
      mocks.calls.push('oauth');
      return { data: {}, error: null };
    });
    mocks.markVisitorDraftForHandover.mockReset();
    mocks.markVisitorDraftForHandover.mockImplementation(() => {
      mocks.calls.push('mark');
      return 'nonce-test-1234';
    });
    window.history.replaceState({}, '', '/create-video?prompt=boat&model=kling-3.0-video&welcome=1&referral=applied');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('says what stays and that nothing runs until Generate is pressed again, with the agreement under Google', async () => {
    renderSheet();

    const dialog = screen.getByRole('dialog', { name: 'Continue to generate' });
    expect(dialog).toHaveAccessibleDescription(
      'New here? You get 25 free credits when you pick a name and handle, enough for this 19-credit run. Either way you come back to this page, and nothing runs until you press Generate.',
    );
    expect(screen.getByText('Your prompt stays')).toBeInTheDocument();
    expect(screen.getByText('Your settings stay: Seedance 2 Mini · 480P · 9:16 · 5s')).toBeInTheDocument();
    expect(screen.getByText('Images you added stay')).toBeInTheDocument();
    const google = screen.getByRole('button', { name: 'Continue with Google' });
    // What a Google sign-up agrees to is said under every Google button (audit 01-6).
    expect(google).toHaveAccessibleDescription(/Prompts and media you generate are processed by the AI providers listed in the policy/);
    expect(screen.getByRole('link', { name: 'listed in the policy' })).toHaveAttribute('href', '/privacy#ai-processing');
    // Focus starts on the way forward.
    await waitFor(() => expect(google).toHaveFocus());
  });

  it('marks the visitor’s draft before leaving for Google, and comes back with its nonce instead of the link’s own settings', async () => {
    renderSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(mocks.calls).toEqual(['mark', 'oauth']);
    expect(mocks.markVisitorDraftForHandover).toHaveBeenCalledWith('video');
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: expect.stringMatching(new RegExp(`^${window.location.origin}/auth/callback\\?next=`)) },
    });
    // The saved draft carries the prompt and model; the link's would be put over it.
    expect(redirectNext()).toBe('/create-video?handover=nonce-test-1234');
  });

  it('marks nothing for a page whose draft is an account’s, and comes back to the same link', async () => {
    renderSheet({ handsOverDraft: false });

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(mocks.markVisitorDraftForHandover).not.toHaveBeenCalled();
    expect(redirectNext()).toBe('/create-video?prompt=boat&model=kling-3.0-video');
  });

  it('says why when Google cannot be started, and stays open', async () => {
    mocks.signInWithOAuth.mockImplementation(async () => ({ data: {}, error: new Error('Network down') }));
    renderSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/./);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  });

  it('is usable again on a page the browser brings back after leaving for Google', async () => {
    mocks.signInWithOAuth.mockImplementation(() => new Promise(() => undefined));
    const { onClose } = renderSheet();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes a password account to the login page, which comes back here', async () => {
    renderSheet({ tool: 'image' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with email and password' }));

    expect(mocks.push).toHaveBeenCalledWith(`/login?returnUrl=${encodeURIComponent('/create-video?handover=nonce-test-1234')}`);
    expect(mocks.markVisitorDraftForHandover).toHaveBeenCalledWith('image');
  });

  it('closes on Escape and on its close button', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('names what was pressed', () => {
    renderSheet({ reason: 'enhance', keepsImages: false });
    expect(screen.getByRole('dialog', { name: 'Continue to enhance your prompt' })).toBeInTheDocument();
    expect(screen.queryByText('Images you added stay')).not.toBeInTheDocument();
  });

  it('draws nothing while closed', () => {
    renderSheet({ reason: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('what signing up gives, in the sheet’s words', () => {
  it('counts the run against the welcome credits only when they cover it', () => {
    expect(creatorSignUpBody(25, 70)).toBe(
      'New here? You get 25 free credits when you pick a name and handle. Either way you come back to this page, and nothing runs until you press Generate.',
    );
    expect(creatorSignUpBody(25, null)).toBe(
      'New here? You get 25 free credits when you pick a name and handle. Either way you come back to this page, and nothing runs until you press Generate.',
    );
    expect(creatorSignUpBody(null, 19)).toBe(
      'Sign in with Google, or make an account with it. Either way you come back to this page, and nothing runs until you press Generate.',
    );
  });
});
