import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '9a7f1c2e-0000-4000-8000-000000000001';
const OTHER = '9a7f1c2e-0000-4000-8000-000000000002';

const harness = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  authListener: null as ((event: string, session: { user: { id: string } } | null) => void) | null,
  read: vi.fn(),
  toasts: [] as Array<{ tone: string; message: string }>,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: harness.session } }),
      onAuthStateChange: (listener: (event: string, session: { user: { id: string } } | null) => void) => {
        harness.authListener = listener;
        return { data: { subscription: { unsubscribe: () => { harness.authListener = null; } } } };
      },
    },
  },
}));

vi.mock('@/lib/welcome-credits-requests', () => ({ readWelcomeCredits: harness.read }));

vi.mock('@/components/feedback-state', () => ({
  pushToast: (toast: { tone: string; message: string }) => {
    harness.toasts.push(toast);
    return harness.toasts.length;
  },
}));

// The card itself is tested on its own (welcome-credits-popup.test.tsx): here, what the gate hands it.
vi.mock('next/dynamic', () => ({
  default: () => function PopupStandIn(props: {
    amount: number;
    referral: string | null;
    onClose: () => void;
    onGone: () => void;
    onAnswer: (answer: unknown) => void;
  }) {
    return (
      <div role="dialog" aria-label="Welcome credits" data-amount={props.amount} data-referral={props.referral ?? ''}>
        <button type="button" onClick={props.onClose}>Close</button>
        <button type="button" onClick={props.onGone}>Gone</button>
        <button type="button" onClick={() => props.onAnswer({ status: 'claimed', amount: 25, credits: 25, identityComplete: true })}>Claimed</button>
      </div>
    );
  },
}));

import WelcomeCreditsGate from '@/components/WelcomeCreditsGate';
import { announceWelcomeOfferChanged, rememberWelcomePopupClosed, resetWelcomePopupSession } from '@/lib/welcome-credits-popup';
import { WELCOME_PROMISE_STORAGE_KEY, resetWelcomePromiseForTests } from '@/lib/welcome-promise';

const eligible = { status: 'eligible', amount: 25, credits: 0, identityComplete: true };

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('who sees the welcome popup, where (owner 11-09)', () => {
  beforeEach(() => {
    harness.session = { user: { id: USER } };
    harness.authListener = null;
    harness.read.mockReset();
    harness.toasts.length = 0;
    resetWelcomePopupSession();
    window.localStorage.clear();
    resetWelcomePromiseForTests();
  });

  afterEach(() => {
    resetWelcomePopupSession();
  });

  it('offers it to a named account with its credits to claim, on a page that offers it', async () => {
    harness.read.mockResolvedValue(eligible);
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toHaveAttribute('data-amount', '25');
  });

  it('asks nothing and offers nothing on a page that does not offer it', async () => {
    harness.read.mockResolvedValue(eligible);
    render(<WelcomeCreditsGate offeredHere={false} returned={null} />);
    await settle();
    expect(harness.read).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers nothing to an account that has no name yet, or nothing to claim', async () => {
    harness.read.mockResolvedValue({ ...eligible, status: 'not_eligible', identityComplete: false });
    const view = render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();

    harness.read.mockResolvedValue({ ...eligible, status: 'legacy_ineligible' });
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('waits until the next browser session once closed, without asking the server meanwhile', async () => {
    harness.read.mockResolvedValue(eligible);
    const view = render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gone' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();

    harness.read.mockClear();
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Another account in the same browser is not held to it.
    harness.session = { user: { id: OTHER } };
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
  });

  it('is offered again in a new browser session until the credits are claimed', async () => {
    harness.read.mockResolvedValue(eligible);
    rememberWelcomePopupClosed(USER);
    resetWelcomePopupSession();
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
  });

  it('remembers an account whose credits are claimed, and asks no more in this browser', async () => {
    harness.read.mockResolvedValue(eligible);
    const view = render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Claimed' }));
    // Latched: the claim's answer does not take the card away mid-celebration.
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Gone' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`magicbooklet:welcome-settled:v1:${USER}`)).not.toBeNull();
    view.unmount();

    harness.read.mockClear();
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).not.toHaveBeenCalled();
  });

  it('takes the card away when the account changes, and offers the next account its own', async () => {
    harness.read.mockResolvedValue(eligible);
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    harness.read.mockResolvedValue({ ...eligible, status: 'already_claimed' });
    act(() => harness.authListener?.('SIGNED_IN', { user: { id: OTHER } }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => harness.authListener?.('SIGNED_OUT', null));
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks again when a creator name is saved on the page, and offers the credits it unlocked', async () => {
    harness.read.mockResolvedValueOnce({ ...eligible, status: 'not_eligible', identityComplete: false });
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    harness.read.mockResolvedValueOnce(eligible);
    act(() => announceWelcomeOfferChanged());
    await settle();
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
  });

  it('asks once while the person moves between pages that offer it', async () => {
    harness.read.mockResolvedValue({ ...eligible, status: 'not_eligible', identityComplete: false });
    const view = render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    view.rerender(<WelcomeCreditsGate offeredHere={false} returned={null} />);
    view.rerender(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).toHaveBeenCalledTimes(1);
  });

  it('says the invite’s outcome inside the card on the page a sign-up returned to', async () => {
    harness.read.mockResolvedValue(eligible);
    render(<WelcomeCreditsGate offeredHere returned={{ pathname: '/showcase', referral: 'applied' }} />);
    await settle();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-referral', 'applied');
    expect(harness.toasts).toEqual([]);
  });

  it('still says it when the welcome credits could not be read', async () => {
    harness.read.mockRejectedValue(new Error('Could not load your welcome credits.'));
    render(<WelcomeCreditsGate offeredHere returned={{ pathname: '/showcase', referral: 'applied' }} />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(harness.toasts).toEqual([expect.objectContaining({ tone: 'success', message: expect.stringMatching(/^Invite applied/) })]);
  });

  it('says it in a toast, once, where no card is offered', async () => {
    harness.read.mockResolvedValue({ ...eligible, status: 'identity_already_claimed' });
    const returned = { pathname: '/showcase', referral: 'self_referral' };
    const view = render(<WelcomeCreditsGate offeredHere returned={returned} />);
    await settle();
    view.rerender(<WelcomeCreditsGate offeredHere returned={returned} />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(harness.toasts).toEqual([
      expect.objectContaining({ tone: 'info', message: 'Invite not applied: you cannot use your own invite link.' }),
    ]);
  });

  // Review of #744 (max): found by its finders, each failing before its fix.
  it('says the invite’s outcome once: not again as a toast after the card has gone', async () => {
    harness.read.mockResolvedValue(eligible);
    render(<WelcomeCreditsGate offeredHere returned={{ pathname: '/showcase', referral: 'applied' }} />);
    await settle();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-referral', 'applied');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gone' }));
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(harness.toasts).toEqual([]);
  });

  it('tells the signed-out promise about an account this browser already knows has claimed', async () => {
    window.localStorage.setItem(`magicbooklet:welcome-settled:v1:${USER}`, String(Date.now()));
    render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WELCOME_PROMISE_STORAGE_KEY)).not.toBeNull();
  });

  it('asks again on the next page after an answer could not be read', async () => {
    harness.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(eligible);
    const view = render(<WelcomeCreditsGate offeredHere returned={null} page="/" />);
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<WelcomeCreditsGate offeredHere returned={null} page="/create-image" />);
    await settle();
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
  });

  it('shows an answer that landed after its page was left, on the next page that offers it', async () => {
    let resolveRead: (value: unknown) => void = () => undefined;
    harness.read.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    const view = render(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    view.rerender(<WelcomeCreditsGate offeredHere={false} returned={null} />);
    await act(async () => {
      resolveRead(eligible);
    });
    await settle();
    view.rerender(<WelcomeCreditsGate offeredHere returned={null} />);
    await settle();
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Welcome credits' })).toBeInTheDocument();
  });
});
