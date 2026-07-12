import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InviteClient, {
  REFERRAL_DISCLOSURE,
  buildReferralCopyText,
  buildReferralShareText,
} from '@/app/invite/InviteClient';

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'referral-access-token' },
    isLoading: false,
  }),
}));

const summary = {
  program: {
    inviterPercent: 5,
    inviteeFirstPurchasePercent: 5,
    attributionWindowDays: 30,
  },
  code: 'MAGIC7K2',
  shareUrl: 'https://magicbooklet.com/r/MAGIC7K2',
  stats: {
    visits: 0,
    signups: 0,
    purchasers: 0,
    creditsEarned: 0,
    creditsReversed: 0,
  },
  recentRewards: [],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('InviteClient', () => {
  const fetchMock = vi.fn();
  const shareMock = vi.fn();
  const writeTextMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    shareMock.mockReset();
    writeTextMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(summary));
    writeTextMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the authenticated referral summary and presents the useful zero state', async () => {
    render(<InviteClient />);

    expect(screen.getByRole('status', { name: 'Loading Invite & Earn' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue(summary.shareUrl)).toBeInTheDocument();
    expect(screen.getByText('Your first referral starts here')).toBeInTheDocument();
    expect(screen.getByText('No rewards yet')).toBeInTheDocument();
    expect(screen.getByText(REFERRAL_DISCLOSURE, { exact: false })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/referrals/me', {
      headers: { Authorization: 'Bearer referral-access-token' },
    });
  });

  it('copies a complete invite message with the required disclosure', async () => {
    render(<InviteClient />);
    await screen.findByDisplayValue(summary.shareUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Copy invite' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(buildReferralCopyText(summary.shareUrl, 5));
    });
    expect(writeTextMock.mock.calls[0]?.[0]).toContain(REFERRAL_DISCLOSURE);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByText('Invite message copied to your clipboard.')).toBeInTheDocument();
  });

  it('uses native sharing with benefit copy, disclosure, and the referral URL', async () => {
    shareMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock,
    });

    render(<InviteClient />);
    await screen.findByDisplayValue(summary.shareUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledWith({
        title: 'Join me on magicbooklet',
        text: buildReferralShareText(5),
        url: summary.shareUrl,
      });
    });
    expect(shareMock.mock.calls[0]?.[0].text).toContain(REFERRAL_DISCLOSURE);
    expect(await screen.findByRole('button', { name: 'Shared' })).toBeInTheDocument();
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it('treats a canceled native share as a neutral exit without copying', async () => {
    shareMock.mockRejectedValue(new DOMException('Canceled by user', 'AbortError'));
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock,
    });

    render(<InviteClient />);
    await screen.findByDisplayValue(summary.shareUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share invite' })).toBeInTheDocument());
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not share/i)).not.toBeInTheDocument();
  });

  it('creates a stable link when the summary has not provisioned one yet', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ...summary, code: null, shareUrl: null }))
      .mockResolvedValueOnce(jsonResponse({ code: summary.code, shareUrl: summary.shareUrl }));

    render(<InviteClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create my invite link' }));

    expect(await screen.findByDisplayValue(summary.shareUrl)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/referrals/link', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer referral-access-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  });

  it('shows a recoverable API error and retries without reloading the page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Referral service is warming up.' }, 503))
      .mockResolvedValueOnce(jsonResponse(summary));

    render(<InviteClient />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Referral service is warming up.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByDisplayValue(summary.shareUrl)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
