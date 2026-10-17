import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'seller-token' } } })),
    },
  },
}));

import PayoutPanel from '@/app/marketplace/sell/PayoutPanel';

const READY_STATE = {
  availableUsd: '$150.00',
  minimumUsd: '$100.00',
  canRequest: true,
  pendingRequest: null,
  history: [],
};

const PENDING_REQUEST = {
  id: 'request-1',
  amountUsd: '$150.00',
  status: 'requested' as const,
  payoutMethod: 'bank_transfer',
  requestedAt: '2026-10-15T10:00:00.000Z',
  resolvedAt: null,
  resolutionNote: null,
  externalReference: null,
};

const PENDING_STATE = {
  availableUsd: '$0.00',
  minimumUsd: '$100.00',
  canRequest: false,
  pendingRequest: PENDING_REQUEST,
  history: [PENDING_REQUEST],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Answers the panel's requests to /api/creator/payouts in order, and keeps
// what each one sent.
function answerPayoutRequests(answers: Response[]) {
  const sent: Array<{ method: string; authorization: string | null; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/creator/payouts');
    const headers = new Headers(init?.headers);
    sent.push({
      method: init?.method ?? 'GET',
      authorization: headers.get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const answer = answers.shift();
    if (!answer) {
      throw new Error('Unexpected payout request');
    }
    return answer;
  }));
  return sent;
}

describe('PayoutPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A failed balance read was a dead end: the text, and no way to read again.
  it('offers a retry when the balance cannot be read, and shows it once a retry reads it', async () => {
    const sent = answerPayoutRequests([
      json({ error: 'Failed to load your payout balance.' }, 500),
      json(READY_STATE),
    ]);

    render(<PayoutPanel />);

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Failed to load your payout balance.');
    fireEvent.click(within(failure).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('Payout balance')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sent.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  // The read after an accepted request used to land in the request's own
  // catch: "Payout requested" and "Failed to request a payout." side by side,
  // with Withdraw still offered for a second, refused, request.
  it('keeps the success notice alone, and asks for a refresh, when the read after an accepted request fails', async () => {
    const sent = answerPayoutRequests([
      json(READY_STATE),
      json({ success: true, requestId: 'request-1', amountTokenSubunits: 1_500_000 }),
      json({ error: 'Failed to load your payout balance.' }, 500),
      json(PENDING_STATE),
    ]);

    render(<PayoutPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Indian bank transfer' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Payout details' }), {
      target: { value: 'Asha Rao 4321, asha@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw $150.00' }));

    expect(await screen.findByText('Payout requested. We will settle it and update this page.')).toBeInTheDocument();
    const refresh = await screen.findByRole('button', { name: 'Refresh to see the update' });
    expect(screen.queryByText('Failed to request a payout.')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load your payout balance.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
    expect(sent[1]).toEqual({
      method: 'POST',
      authorization: 'Bearer seller-token',
      body: { payoutMethod: 'bank_transfer', payoutDetails: 'Asha Rao 4321, asha@example.com' },
    });

    fireEvent.click(refresh);

    expect(await screen.findByText('$150.00 payout in progress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh to see the update' })).not.toBeInTheDocument();
    expect(screen.getByText('Payout requested. We will settle it and update this page.')).toBeInTheDocument();
    expect(sent).toHaveLength(4);
  });

  // A PayPal request has answered 400 METHOD_UNAVAILABLE since 2026-10-17
  // (decision 7); the panel no longer sends one, but says what the server says.
  it.each([
    [
      'a second request',
      'You already have a payout in progress. It has to be settled before you can request another.',
      'ALREADY_PENDING',
      409,
    ],
    [
      'a method the server stopped taking',
      'PayPal payouts are coming soon. Choose UPI or an Indian bank transfer.',
      'METHOD_UNAVAILABLE',
      400,
    ],
  ])('shows a refused request (%s) as the refusal alone', async (_name, refusal, code, status) => {
    answerPayoutRequests([json(READY_STATE), json({ error: refusal, code }, status)]);

    render(<PayoutPanel />);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Payout details' }), {
      target: { value: 'asha@upi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw $150.00' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText(/Payout requested/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw $150.00' })).toBeEnabled();
  });

  // A request made before 2026-10-17 may name PayPal: it still reads by name.
  it.each([
    ['bank_transfer', /via Indian bank transfer\./],
    ['paypal', /via PayPal\./],
  ])('names the payout method of a request in progress (%s), not its id', async (payoutMethod, label) => {
    answerPayoutRequests([json({
      ...PENDING_STATE,
      pendingRequest: { ...PENDING_REQUEST, payoutMethod },
      history: [{ ...PENDING_REQUEST, payoutMethod }],
    })]);

    render(<PayoutPanel />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(payoutMethod))).not.toBeInTheDocument();
  });

  // Decision 7 (2026-10-17): payouts are sent in rupees, by UPI or an Indian
  // bank transfer; PayPal and international transfers are listed as coming
  // soon and can be neither chosen nor sent.
  it('offers UPI and Indian bank transfer only, each with its own details, and lists the others as coming soon', async () => {
    const sent = answerPayoutRequests([
      json(READY_STATE),
      json({ success: true, requestId: 'request-1', amountTokenSubunits: 1_500_000 }),
      json(PENDING_STATE),
    ]);

    render(<PayoutPanel />);

    const details = await screen.findByRole('textbox', { name: 'Payout details' });
    expect(details).toHaveAttribute('placeholder', 'your-name@bank');
    expect(details).toHaveAttribute('maxLength', '500');
    expect(screen.getByText(
      /paid in INR to a UPI ID or an Indian bank account within 14 days of your request/
    )).toBeInTheDocument();
    expect(screen.queryByText(/PayPal email/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Indian bank transfer' }));
    expect(details).toHaveAttribute('placeholder', 'Account name and last 4 digits, plus a contact');

    for (const name of ['PayPal Coming soon', 'International transfer Coming soon']) {
      const unavailable = screen.getByRole('button', { name });
      expect(unavailable).toBeDisabled();
      fireEvent.click(unavailable);
    }
    expect(details).toHaveAttribute('placeholder', 'Account name and last 4 digits, plus a contact');

    fireEvent.change(details, { target: { value: 'Asha Rao 4321, asha@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw $150.00' }));

    expect(await screen.findByText('$150.00 payout in progress')).toBeInTheDocument();
    expect(sent[1].body).toEqual({ payoutMethod: 'bank_transfer', payoutDetails: 'Asha Rao 4321, asha@example.com' });
  });
});
