import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { ApiError, type CreatorPayoutRequestSummary, type CreatorPayoutStateResponse } from '../lib/api-client';
import {
  checkPayoutDetails,
  CREATOR_PAYOUT_DETAILS_MISSING,
} from '../lib/creator-payout-policy/creator-payout-policy';
import {
  getCreatorPayoutCard,
  payoutConfirmation,
  payoutHistoryRows,
  payoutRequestFailure,
} from '../lib/creator-payout-view-model';

function state(overrides: Partial<CreatorPayoutStateResponse> = {}): CreatorPayoutStateResponse {
  return {
    success: true,
    availableTokenSubunits: 85_000,
    heldTokenSubunits: 0,
    lifetimeEarnedTokenSubunits: 85_000,
    lifetimePaidOutTokenSubunits: 0,
    availableUsd: '$8.50',
    minimumTokenSubunits: 1_000_000,
    minimumUsd: '$100.00',
    canRequest: false,
    pendingRequest: null,
    history: [],
    ...overrides,
  };
}

function request(overrides: Partial<CreatorPayoutRequestSummary> = {}): CreatorPayoutRequestSummary {
  return {
    id: 'request-1',
    amountTokenSubunits: 1_100_000,
    amountUsd: '$110.00',
    status: 'requested',
    payoutMethod: 'upi',
    requestedAt: '2026-11-11T06:30:00.000Z',
    resolvedAt: null,
    resolutionNote: null,
    externalReference: null,
    ...overrides,
  };
}

describe('the Recipe Sales payout card', () => {
  it('waits for the first read, and a failed read wins over an older balance', () => {
    expect(getCreatorPayoutCard({ isError: false }).kind).toBe('loading');
    expect(getCreatorPayoutCard({ isError: true, data: state({ canRequest: true }) })).toMatchObject({
      kind: 'unavailable',
      caption: 'Balance unavailable',
    });
  });

  it('shows the way to the floor below it, with where payouts go', () => {
    const card = getCreatorPayoutCard({ isError: false, data: state() });

    expect(card).toMatchObject({
      kind: 'progress',
      balance: '$8.50',
      caption: 'Lifetime $8.50',
      progress: 0.085,
      railsLine: 'Withdraw from $100.00, paid in INR to UPI or an Indian bank.',
    });
  });

  it('offers Withdraw once the server says a request can go in', () => {
    const card = getCreatorPayoutCard({
      isError: false,
      data: state({ availableTokenSubunits: 1_100_000, availableUsd: '$110.00', canRequest: true }),
    });

    expect(card).toMatchObject({
      kind: 'ready',
      caption: 'Ready to withdraw · lifetime $8.50',
      withdrawLabel: 'Withdraw $110.00',
      progress: 1,
    });
  });

  it('puts a payout in progress in place of Withdraw', () => {
    const card = getCreatorPayoutCard({
      isError: false,
      data: state({ availableTokenSubunits: 0, availableUsd: '$0.00', canRequest: true, pendingRequest: request(), history: [request()] }),
    });

    expect(card.kind).toBe('pending');
    expect(card).toMatchObject({
      pending: {
        title: '$110.00 payout in progress',
        body: expect.stringMatching(/via UPI\. It arrives within 14 days of the request\.$/),
      },
    });
  });

  it('says why the last payout was turned down until another replaces it', () => {
    const rejected = request({ status: 'rejected', resolutionNote: 'The UPI ID did not resolve.', resolvedAt: '2026-11-12T06:30:00.000Z' });

    expect(getCreatorPayoutCard({ isError: false, data: state({ history: [rejected] }) })).toMatchObject({
      rejection: { title: 'Your $110.00 payout wasn’t sent.', body: 'The UPI ID did not resolve.' },
    });
    expect(getCreatorPayoutCard({
      isError: false,
      data: state({ pendingRequest: request({ id: 'request-2' }), history: [request({ id: 'request-2' }), rejected] }),
    })).toMatchObject({ rejection: null });
  });

  it('lists the history with a reason or the bank’s reference', () => {
    const rows = payoutHistoryRows([
      request({ id: 'a', status: 'paid', externalReference: 'UTR123', resolvedAt: '2026-11-13T06:30:00.000Z' }),
      request({ id: 'b', status: 'rejected', resolutionNote: 'Wrong account.' }),
      request({ id: 'c' }),
    ]);

    expect(rows.map(({ title, note, noteTone }) => ({ title, note, noteTone }))).toEqual([
      { title: '$110.00 · Paid', note: 'Ref UTR123', noteTone: 'faint' },
      { title: '$110.00 · Rejected', note: 'Wrong account.', noteTone: 'danger' },
      { title: '$110.00 · In progress', note: null, noteTone: 'faint' },
    ]);
  });
});

describe('a payout request from the app', () => {
  const endpoint = mobileApiContract.endpoints.requestCreatorPayout;

  it('asks before it moves the whole balance', () => {
    expect(payoutConfirmation('$110.00', 'upi', ' creator@okbank ')).toEqual({
      title: 'Withdraw $110.00?',
      message: 'We’ll send it by UPI to creator@okbank within 14 days.',
      confirmLabel: 'Request payout',
    });
  });

  it.each(Object.entries(endpoint.errors))('shows the server’s words for %s', (_key, refusal) => {
    const error = new ApiError(refusal.response.error, refusal.status, refusal.response, undefined, refusal.response.code);

    expect(payoutRequestFailure(error)).toBe(refusal.response.error);
  });

  it('says an ended session in plain words, never a bare "Unauthorized"', () => {
    expect(payoutRequestFailure(new ApiError('Unauthorized', 401, { error: 'Unauthorized' }, undefined, 'UNAUTHORIZED')))
      .toBe('Your session ended. Sign in again, then request the payout.');
  });

  it.each([
    ['no network', new TypeError('Network request failed')],
    ['a server error', new ApiError('Failed to request a payout.', 500, { error: 'Failed to request a payout.' })],
    ['an unknown code', new ApiError('Something odd', 400, {}, undefined, 'SOMETHING_ELSE')],
  ])('says to retry after %s', (_case, error) => {
    expect(payoutRequestFailure(error)).toBe('Couldn’t request the payout. Check your connection, then try again.');
  });

  it('holds the details to the server’s bounds before sending', () => {
    expect(checkPayoutDetails('upi', '  ')).toBe(CREATOR_PAYOUT_DETAILS_MISSING);
    expect(checkPayoutDetails('bank_transfer', 'x'.repeat(501))).toBe(CREATOR_PAYOUT_DETAILS_MISSING);
    expect(checkPayoutDetails('upi', endpoint.request.payoutDetails)).toBeNull();
  });
});
