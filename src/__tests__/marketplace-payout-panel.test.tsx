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
    expect(screen.getByText('Earnings')).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw $150.00' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Indian bank transfer' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Payout details' }), {
      target: { value: 'Asha Rao 4321, asha@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request payout' }));

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

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw $150.00' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Payout details' }), {
      target: { value: 'asha@upi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request payout' }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText(/Payout requested/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request payout' })).toBeEnabled();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw $150.00' }));
    const details = screen.getByRole('textbox', { name: 'Payout details' });
    expect(details).toHaveAttribute('placeholder', 'your-name@bank');
    expect(details).toHaveAttribute('maxLength', '500');
    expect(screen.getByText(
      /paid in INR to a UPI ID or an Indian bank account within 14 days of your request/
    )).toBeInTheDocument();
    expect(screen.queryByText(/PayPal email/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Indian bank transfer' }));
    expect(details).toHaveAttribute('placeholder', 'Account name and last 4 digits, plus a contact');

    for (const name of ['PayPal Coming soon', 'International transfer Coming soon']) {
      const unavailable = screen.getByRole('radio', { name });
      expect(unavailable).toBeDisabled();
      fireEvent.click(unavailable);
    }
    expect(details).toHaveAttribute('placeholder', 'Account name and last 4 digits, plus a contact');

    fireEvent.change(details, { target: { value: 'Asha Rao 4321, asha@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request payout' }));

    expect(await screen.findByText('$150.00 payout in progress')).toBeInTheDocument();
    expect(sent[1].body).toEqual({ payoutMethod: 'bank_transfer', payoutDetails: 'Asha Rao 4321, asha@example.com' });
  });

  // 2026-11-01: the tile says how far the balance is from the first payout,
  // where the panel only said "You can withdraw once your balance reaches".
  // Review 14: the INR and UPI rule was said only in the form, which opens at
  // the minimum, so a seller abroad learned it at $100.
  it('shows how far a balance under the minimum is from the first payout, and how payouts are paid', async () => {
    answerPayoutRequests([json({
      ...READY_STATE,
      availableUsd: '$42.50',
      canRequest: false,
      availableTokenSubunits: 425_000,
      minimumTokenSubunits: 1_000_000,
    })]);

    render(<PayoutPanel />);

    const progress = await screen.findByRole('progressbar', { name: 'Balance toward the payout minimum' });
    expect(progress).toHaveAttribute('aria-valuenow', '43');
    expect(progress).toHaveAttribute('aria-valuetext', '$42.50 of $100.00');
    expect(progress.firstElementChild).toHaveStyle({ width: '42.5%' });
    expect(screen.getByText('Withdraw from $100.00, paid in INR to UPI or an Indian bank.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
  });

  // Review 14: the rejection alert sends the seller here for the reason, which
  // sat in the closed history while Withdraw offered the same details again.
  it('says why the last payout was not sent, until a new request replaces it', async () => {
    const rejected = {
      ...PENDING_REQUEST,
      status: 'rejected' as const,
      resolvedAt: '2026-10-18T10:00:00.000Z',
      resolutionNote: 'The UPI ID did not match the account name.',
    };
    answerPayoutRequests([json({ ...READY_STATE, history: [rejected] })]);

    render(<PayoutPanel />);

    const reason = (await screen.findByText('Your $150.00 payout wasn’t sent.')).closest('p') as HTMLElement;
    expect(reason).toHaveTextContent('The UPI ID did not match the account name.');
    expect(screen.getByRole('button', { name: 'Withdraw $150.00' })).toBeInTheDocument();
  });

  it('says nothing of a rejection once a newer request is in progress', async () => {
    const rejected = { ...PENDING_REQUEST, id: 'request-0', status: 'rejected' as const, resolutionNote: 'Wrong UPI ID.' };
    answerPayoutRequests([json({ ...PENDING_STATE, history: [PENDING_REQUEST, rejected] })]);

    render(<PayoutPanel />);

    expect(await screen.findByText('$150.00 payout in progress')).toBeInTheDocument();
    expect(screen.queryByText(/payout wasn’t sent/)).not.toBeInTheDocument();
  });

  // Second review: below the minimum the tile showed no total of what the
  // seller has earned, once the Tracked earnings tile was gone.
  it('shows what the seller has earned in all under a balance below the minimum', async () => {
    answerPayoutRequests([json({
      ...READY_STATE,
      availableUsd: '$10.00',
      canRequest: false,
      availableTokenSubunits: 100_000,
      minimumTokenSubunits: 1_000_000,
      lifetimeEarnedTokenSubunits: 6_100_000,
    })]);

    render(<PayoutPanel />);

    expect(await screen.findByText('Lifetime $610.00')).toBeInTheDocument();
  });

  // Second review: the request's answer is drawn in the form, so closing the
  // form while it was on its way lost a refusal.
  it('keeps the form while a request is on its way, and shows its refusal', async () => {
    let answerRequest: (response: Response) => void = () => undefined;
    answerPayoutRequests([
      json(READY_STATE),
      new Promise<Response>((resolve) => { answerRequest = resolve; }) as unknown as Response,
    ]);

    render(<PayoutPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw $150.00' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Payout details' }), { target: { value: 'asha@upi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request payout' }));

    expect(await screen.findByRole('button', { name: 'Requesting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Payout details' }), { key: 'Escape' });
    expect(screen.getByRole('textbox', { name: 'Payout details' })).toBeInTheDocument();

    answerRequest(json({ error: 'You already have a payout in progress.', code: 'ALREADY_PENDING' }, 409));

    expect(await screen.findByText('You already have a payout in progress.')).toBeInTheDocument();
  });

  // Second review: a guest reaches the page, the route refuses them, and the
  // error's Retry could never work. Beside no recipe the tile is extra.
  it('draws nothing for a balance it cannot read when asked to hide an empty one', async () => {
    answerPayoutRequests([json({ error: 'Unauthorized' }, 401), json({ error: 'Unauthorized' }, 401)]);

    render(<><PayoutPanel hideWhenEmpty /><PayoutPanel /></>);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Earnings' })).toHaveLength(1);
  });

  // Review 4: a seller with no recipe left can still have a balance (a legacy
  // listing, every recipe gone), and /delete-account sends them here for it.
  // A panel drawn beside it without the option says when its read has landed.
  it('draws nothing for an empty balance when asked to, and the tile for any balance', async () => {
    const empty = {
      ...READY_STATE,
      availableUsd: '$0.00',
      canRequest: false,
      availableTokenSubunits: 0,
      minimumTokenSubunits: 1_000_000,
      lifetimeEarnedTokenSubunits: 0,
    };
    answerPayoutRequests([json(empty), json(empty)]);

    const { unmount } = render(<><PayoutPanel hideWhenEmpty /><PayoutPanel /></>);

    expect(await screen.findByText('$0.00')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Earnings' })).toHaveLength(1);
    unmount();

    answerPayoutRequests([json({ ...empty, availableUsd: '$4.25', availableTokenSubunits: 42_500, lifetimeEarnedTokenSubunits: 42_500 })]);
    render(<PayoutPanel hideWhenEmpty />);

    expect(await screen.findByText('$4.25')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Earnings' })).toBeInTheDocument();
  });

  // Withdraw opens the form under the tiles, past the rest of the overview:
  // the focus goes to its chosen method, and Escape hands it back.
  it('moves the focus into the form it opens, and back to Withdraw when Escape closes it', async () => {
    answerPayoutRequests([json(READY_STATE)]);

    render(<PayoutPanel />);

    const withdraw = await screen.findByRole('button', { name: 'Withdraw $150.00' });
    expect(withdraw).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(withdraw);

    const upi = screen.getByRole('radio', { name: 'UPI' });
    expect(upi).toHaveFocus();
    expect(withdraw).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(upi, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Payout details' })).not.toBeInTheDocument();
    expect(withdraw).toHaveFocus();
    expect(withdraw).toHaveAttribute('aria-expanded', 'false');
  });
});
