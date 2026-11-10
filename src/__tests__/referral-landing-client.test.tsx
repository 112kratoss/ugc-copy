import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReferralLandingClient from '@/app/r/[code]/ReferralLandingClient';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function visitAnswer(program: unknown) {
  return {
    success: true,
    visitToken: '0b5f0f8e-6a3c-4c4e-9d1a-2f3b4c5d6e7f',
    code: 'creator123',
    expiresAt: '2026-11-14T00:00:00.000Z',
    program,
  };
}

function renderLanding() {
  return render(
    <ReferralLandingClient code="creator123" destination="/create" />
  );
}

describe('ReferralLandingClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the offer the visit answer carries, not numbers of its own', async () => {
    fetchMock.mockResolvedValue(jsonResponse(visitAnswer({
      inviterPercent: 7,
      inviteeFirstPurchasePercent: 2.5,
      attributionWindowDays: 14,
    })));

    renderLanding();

    expect(screen.getByRole('heading', { level: 1, name: 'Get bonus credits on your first top-up.' })).toBeInTheDocument();
    expect(screen.getByText('Securely saving this invite.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'Get 2.5% bonus credits on your first top-up.',
    })).toBeInTheDocument();
    expect(screen.getByText(
      'Invite saved for 14 days. Create your new account to keep the first top-up bonus.'
    )).toBeInTheDocument();
    // Nothing left of the old hard-coded 5% / 30 days.
    expect(screen.queryByText(/(?<![\d.])5%|\b30 days/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/referrals/visit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ code: 'creator123', source: 'web', next: '/create' }),
    }));
  });

  // A browser keeps the first invite link it opened. Saying "saved" credited
  // the earlier invite without anyone knowing (review of 2026-11-10).
  it('says when an invite opened earlier in this browser is the one kept', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...visitAnswer(null), code: 'earlier12', preserved: true }));

    renderLanding();

    expect(await screen.findByText(
      'You opened another invite in this browser first, and that one is kept. Create your new account to keep the first top-up bonus.'
    )).toBeInTheDocument();
    expect(screen.queryByText(/Invite saved/)).toBeNull();
  });

  // The way to the app that keeps the invite (the cross-device plan, 2026-11-10): offered
  // only once the invite is saved, and for the invite this browser holds.
  it('offers to carry the saved invite on to the app, on a laptop as a QR code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(visitAnswer(null)));
    renderLanding();

    expect(screen.queryByRole('button', { name: 'Get the app' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Get the app' }));
    expect(await screen.findByRole('dialog', { name: 'Scan to open this on your phone' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  });

  it('offers nothing while the invite is not saved', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'Invalid referral code.' }, 400));
    renderLanding();

    expect(await screen.findByText('Invalid referral code.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get the app' })).toBeNull();
  });

  it('leaves the numbers out when the visit carries no terms', async () => {
    fetchMock.mockResolvedValue(jsonResponse(visitAnswer(null)));

    renderLanding();

    expect(await screen.findByText(
      'Invite saved. Create your new account to keep the first top-up bonus.'
    )).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Get bonus credits on your first top-up.' })).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?%/)).toBeNull();
    expect(screen.queryByText(/\d+ days/)).toBeNull();
  });

  it('warns beside "I already have an account" that the invite is for new accounts only', async () => {
    fetchMock.mockResolvedValue(jsonResponse(visitAnswer(null)));

    renderLanding();
    await screen.findByText(/Invite saved/);

    const existingAccount = screen.getByRole('link', { name: 'I already have an account' });
    expect(existingAccount).toHaveAccessibleDescription('New accounts only: signing in does not apply this invite.');
    expect(screen.getByRole('link', { name: /Create new account/ })).toHaveAttribute(
      'href',
      '/login?mode=signup&next=%2Fcreate'
    );
  });

  it('shows why an invite was not saved and saves it again on Retry', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false, error: 'Referral code not found.' }, 404))
      .mockResolvedValueOnce(jsonResponse(visitAnswer({
        inviterPercent: 5,
        inviteeFirstPurchasePercent: 5,
        attributionWindowDays: 30,
      })));

    renderLanding();

    expect(await screen.findByText('Referral code not found.')).toBeInTheDocument();
    expect(screen.getByText('Invite not saved yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText(
        'Invite saved for 30 days. Create your new account to keep the first top-up bonus.'
      )).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A hidden <Activity> runs every cleanup and every effect again.
  it('keeps the saved invite and its terms when the visit effect runs again', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(visitAnswer({
      inviterPercent: 5,
      inviteeFirstPurchasePercent: 4,
      attributionWindowDays: 21,
    })));
    const inActivity = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <ReferralLandingClient code="creator123" destination="/create" />
      </Activity>
    );

    const { rerender } = render(inActivity('visible'));
    await screen.findByText('Invite saved for 21 days. Create your new account to keep the first top-up bonus.');

    rerender(inActivity('hidden'));
    rerender(inActivity('visible'));
    // The positive control: the visit was posted again (the server keeps the first one).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(await screen.findByText(
      'Invite saved for 21 days. Create your new account to keep the first top-up bonus.'
    )).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Get 4% bonus credits on your first top-up.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create new account/ })).not.toHaveAttribute('aria-disabled', 'true');
  });
});
