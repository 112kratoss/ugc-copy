import { describe, expect, it, vi } from 'vitest';

import { recordInviteVisitFromSharedLink } from '@/lib/invite-share-landing';

const CODE = '30b5f916c7aa';

function fetchSpy() {
  return vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch;
}

describe('the invite a shared link carried, recorded by the page it opened', () => {
  it('sends the invite landing’s own request for a visitor with no account', () => {
    const fetchImpl = fetchSpy();

    expect(recordInviteVisitFromSharedLink({
      search: `s=showcase-reel&r=${CODE}`,
      path: '/showcase/post-1',
      viewerHasAccount: false,
      fetchImpl,
    })).toBe(true);

    expect(vi.mocked(fetchImpl).mock.calls).toEqual([['/api/referrals/visit', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      // No bearer: the route is public, and a visit is not the visitor's to sign.
      body: JSON.stringify({ code: CODE, source: 'web', next: '/showcase/post-1' }),
    }]]);
  });

  it('records nothing for an account that exists: it can never be invited', () => {
    const fetchImpl = fetchSpy();

    expect(recordInviteVisitFromSharedLink({
      search: `?r=${CODE}`,
      path: '/creators/athul',
      viewerHasAccount: true,
      fetchImpl,
    })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', 's=feed', 'r=nope', 'ref=30b5f916c7aa'])(
    'records nothing for a link with no invite on it (%j)',
    (search) => {
      const fetchImpl = fetchSpy();

      expect(recordInviteVisitFromSharedLink({ search, path: '/showcase/post-1', viewerHasAccount: false, fetchImpl }))
        .toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('never lets a failed request reach the page', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;

    expect(recordInviteVisitFromSharedLink({ search: `r=${CODE}`, path: '/showcase/post-1', viewerHasAccount: false, fetchImpl }))
      .toBe(true);
    // The rejection is swallowed inside: nothing is left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
