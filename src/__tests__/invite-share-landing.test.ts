import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock('@/components/feedback-state', () => ({ pushToast: toasts.pushToast }));

import {
  INVITE_SHARE_DISCLOSURE,
  INVITE_VISIT_RETRY_DELAYS_MS,
  PENDING_SHARED_INVITE_KEY,
  recordInviteVisitFromSharedLink,
  settlePendingSharedInviteVisit,
  useInviteVisitFromSharedLink,
} from '@/lib/invite-share-landing';

const CODE = '30b5f916c7aa';

/** The visit route's answers in turn: a status, an error, or a body for a 200. */
function answers(...statuses: Array<number | Error | Record<string, unknown>>) {
  const queue = [...statuses];
  return vi.fn(async () => {
    const next = queue.shift() ?? 200;
    if (next instanceof Error) throw next;
    if (typeof next === 'object') return new Response(JSON.stringify(next), { status: 200 });
    const body = next === 200 ? { success: true, code: CODE, preserved: false } : { success: false };
    return new Response(JSON.stringify(body), { status: next });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const noWait = vi.fn(async (_ms: number) => undefined);

// The page a shared link opened records its sharer's invite for a visitor with
// no account, with the invite landing's own request.
describe('recording the invite a shared link carried', () => {
  beforeEach(() => {
    noWait.mockClear();
  });

  it('sends the invite landing’s own request, marked as a shared link’s', async () => {
    const fetchImpl = answers(200);

    await expect(recordInviteVisitFromSharedLink({
      search: `?s=feed&r=${CODE}`, path: '/showcase/post-1', viewerHasAccount: false, fetchImpl, sleep: noWait,
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith('/api/referrals/visit', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: CODE, source: 'web', kind: 'shared_link', next: '/showcase/post-1' }),
    });
  });

  it('records nothing for an account that exists: it can never be invited', async () => {
    const fetchImpl = answers();
    await expect(recordInviteVisitFromSharedLink({
      search: `r=${CODE}`, path: '/showcase/post-1', viewerHasAccount: true, fetchImpl,
    })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', 's=feed', 'r=nope', `ref=${CODE}`])('records nothing for a link with no invite on it (%j)', async (search) => {
    const fetchImpl = answers();
    await expect(recordInviteVisitFromSharedLink({ search, path: '/', viewerHasAccount: false, fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // A visit that failed was gone for good (review of 2026-11-10).
  it('tries twice more after an outage, a rate limit or a network failure', async () => {
    const fetchImpl = answers(new TypeError('Failed to fetch'), 429, 200);

    await expect(recordInviteVisitFromSharedLink({
      search: `r=${CODE}`, path: '/', viewerHasAccount: false, fetchImpl, sleep: noWait,
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noWait.mock.calls.map(([ms]) => ms)).toEqual([...INVITE_VISIT_RETRY_DELAYS_MS]);
  });

  // The browser keeps an earlier invite; telling the visitor this link's
  // sharer may earn named the wrong person (re-review of 2026-11-10).
  it('says true only when this link\u2019s invite is the one newly kept', async () => {
    for (const body of [
      { success: true, code: 'earlier12', preserved: true },
      { success: true, code: CODE, preserved: true },
      { success: true, code: 'earlier12', preserved: false },
    ]) {
      await expect(recordInviteVisitFromSharedLink({
        search: `r=${CODE}`, path: '/', viewerHasAccount: false, fetchImpl: answers(body), sleep: noWait,
      })).resolves.toBe(false);
    }
  });

  it('gives up after three tries, and never on a code the server refuses', async () => {
    const failing = answers(503, 503, 503, 200);
    await expect(recordInviteVisitFromSharedLink({
      search: `r=${CODE}`, path: '/', viewerHasAccount: false, fetchImpl: failing, sleep: noWait,
    })).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(3);

    const refused = answers(404);
    await expect(recordInviteVisitFromSharedLink({
      search: `r=${CODE}`, path: '/', viewerHasAccount: false, fetchImpl: refused, sleep: noWait,
    })).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

// A capture that failed every try is kept for the tab, and the sign-in page
// records it before the account is made: a visit after it is refused
// (re-review of 2026-11-10).
describe('a shared link\u2019s invite that could not be recorded', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('is kept for the tab, and recorded before a sign-in', async () => {
    await recordInviteVisitFromSharedLink({
      search: `r=${CODE}`, path: '/showcase/post-1', viewerHasAccount: false, fetchImpl: answers(503, 503, 503), sleep: noWait,
    });
    expect(JSON.parse(window.sessionStorage.getItem(PENDING_SHARED_INVITE_KEY)!)).toEqual({ code: CODE, path: '/showcase/post-1' });

    const fetchImpl = answers(200);
    await settlePendingSharedInviteVisit({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('/api/referrals/visit', expect.objectContaining({
      body: JSON.stringify({ code: CODE, source: 'web', kind: 'shared_link', next: '/showcase/post-1' }),
    }));
    expect(window.sessionStorage.getItem(PENDING_SHARED_INVITE_KEY)).toBeNull();
  });

  it('stays kept while offline, goes once refused, and never holds a sign-in long', async () => {
    window.sessionStorage.setItem(PENDING_SHARED_INVITE_KEY, JSON.stringify({ code: CODE, path: '/' }));
    await settlePendingSharedInviteVisit({ fetchImpl: answers(new TypeError('Failed to fetch')) });
    expect(window.sessionStorage.getItem(PENDING_SHARED_INVITE_KEY)).not.toBeNull();

    await settlePendingSharedInviteVisit({ fetchImpl: answers(404) });
    expect(window.sessionStorage.getItem(PENDING_SHARED_INVITE_KEY)).toBeNull();

    window.sessionStorage.setItem(PENDING_SHARED_INVITE_KEY, JSON.stringify({ code: CODE, path: '/' }));
    const never = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    await settlePendingSharedInviteVisit({ fetchImpl: never, timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does nothing with nothing kept', async () => {
    const fetchImpl = answers();
    await settlePendingSharedInviteVisit({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the page that a shared link opened', () => {
  beforeEach(() => {
    toasts.pushToast.mockClear();
    window.history.replaceState(null, '', `/showcase/post-1?s=feed&r=${CODE}#comments`);
    vi.stubGlobal('fetch', answers(200));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  // A visitor who copied the address bar re-shared the original sharer's code
  // (review of 2026-11-10).
  it('takes the code off the address bar, records the visit and says the sharer may earn from it', async () => {
    renderHook(() => useInviteVisitFromSharedLink({
      search: `?s=feed&r=${CODE}`, path: '/showcase/post-1', viewerKnown: true, viewerHasAccount: false,
    }));

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/showcase/post-1?s=feed#comments');
    await waitFor(() => expect(toasts.pushToast).toHaveBeenCalledWith({ tone: 'info', message: INVITE_SHARE_DISCLOSURE, durationMs: 8_000 }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('takes the code off for an account too, and records and says nothing', async () => {
    renderHook(() => useInviteVisitFromSharedLink({
      search: `?s=feed&r=${CODE}`, path: '/showcase/post-1', viewerKnown: true, viewerHasAccount: true,
    }));

    expect(window.location.search).toBe('?s=feed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    expect(toasts.pushToast).not.toHaveBeenCalled();
  });

  it('waits until the viewer is known, then acts once', async () => {
    const { rerender } = renderHook((props: { viewerKnown: boolean }) => useInviteVisitFromSharedLink({
      search: `?s=feed&r=${CODE}`, path: '/showcase/post-1', viewerKnown: props.viewerKnown, viewerHasAccount: false,
    }), { initialProps: { viewerKnown: false } });
    expect(window.location.search).toBe(`?s=feed&r=${CODE}`);
    expect(fetch).not.toHaveBeenCalled();

    rerender({ viewerKnown: true });
    rerender({ viewerKnown: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
});
