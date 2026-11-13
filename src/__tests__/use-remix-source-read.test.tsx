import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { RemixSourceBundle } from '@/lib/remix-source';
import { REMIX_RESTORE_WARNING } from '@/lib/remix-source-client';
import { readRemixSource, useRemixSourceRead } from '@/lib/use-remix-source-read';

type BrowserSession = { access_token: string; user: { id: string } } | null;

// The browser's auth client: the session it holds, which can be another account's (one signed in
// from another tab) or none (a lapse, the E2E sign-in).
const browser = vi.hoisted(() => ({ session: null as BrowserSession }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: browser.session } })),
    },
  },
}));

const BUNDLE: RemixSourceBundle = {
  generation: { id: 'gen-1', title: 'Harbour', prompt: '@lead walks past @prop at dusk', category: 'image', model: 'nano-banana-2' },
  result: { mediaType: 'image', url: 'https://example.com/result.png' },
  inputs: {},
  workflowSettings: { model: 'nano-banana-2' },
  restoreIssues: [],
};

type Answer = { status: number; body: unknown } | Error;

/**
 * The remix source: each read answers the next of `failures` (a status and body, or an Error the fetch
 * throws: the network), then the bundle, each after `hold` settles.
 */
function stubSource({ failures = [], hold = null }: { failures?: Answer[]; hold?: Promise<unknown> | null } = {}) {
  const queue = [...failures];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    void _input;
    void _init;
    if (hold) await hold;
    const answer = queue.shift() ?? { status: 200, body: BUNDLE };
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The session each read went under, as its Authorization header names it. */
function tokensOf(fetchMock: ReturnType<typeof stubSource>) {
  return fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization);
}

/** A read held until the test lets it answer. */
function held() {
  let answer: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { answer = resolve; });
  return { hold, release: () => act(async () => answer()) };
}

type Field = 'model' | 'aspectRatio';
type Props = { pageToken: string | null; formAccount: string | null };
/** What the form was told when an answer landed. */
type Taken = { bundle: RemixSourceBundle; prompt: boolean; model: boolean; aspectRatio: boolean };

/** The hook as a creator form holds it: its prompt, and what each answer put on it. */
function renderRead({ props = {}, prompt = '', strict = false, onSource }: {
  props?: Partial<Props>;
  prompt?: string;
  strict?: boolean;
  onSource?: () => void;
} = {}) {
  const promptRef = { current: prompt };
  const taken: Taken[] = [];
  const view = renderHook(
    ({ pageToken, formAccount }: Props) => useRemixSourceRead<Field>({
      remixId: 'gen-1',
      remixPostId: 'post-1',
      pageToken,
      formAccount,
      promptRef,
      onSource: (bundle, edits) => {
        taken.push({ bundle, prompt: edits.prompt, model: edits.byHand('model'), aspectRatio: edits.byHand('aspectRatio') });
        onSource?.();
      },
    }),
    // Testing Library's own Strict Mode: a StrictMode wrapper around the hook ran its effects once here.
    { initialProps: { pageToken: 'page-token', formAccount: 'user-1', ...props }, reactStrictMode: strict },
  );
  return { ...view, promptRef, taken };
}

/** Lets the effects a redraw starts run, and anything they started settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useRemixSourceRead', () => {
  beforeEach(() => {
    browser.session = { access_token: 'page-token', user: { id: 'user-1' } };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the remix and its post once, and puts the answer on the form', async () => {
    const fetchMock = stubSource();
    const { result, taken } = renderRead();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/remix-source?id=gen-1&postId=post-1']);
    expect(taken.map((answer) => answer.bundle)).toEqual([BUNDLE]);
    expect(result.current.failureWarning).toBeNull();
  });

  // Supabase renews the token about hourly, and a lapse's return brings a new one: neither is
  // another reader, and reading again put the original back over the creator's work.
  it('never reads again for a renewed token or a lapse’s return', async () => {
    const fetchMock = stubSource();
    const { result, rerender, taken } = renderRead();
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ pageToken: 'renewed-token', formAccount: 'user-1' });
    await settle();
    rerender({ pageToken: null, formAccount: 'user-1' });
    await settle();
    rerender({ pageToken: 'token-after-lapse', formAccount: 'user-1' });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(taken).toHaveLength(1);
  });

  it('reads once though the token is renewed while the read is out, and takes that read’s answer', async () => {
    const { hold, release } = held();
    const fetchMock = stubSource({ hold });
    const { result, rerender, taken } = renderRead();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ pageToken: 'renewed-token', formAccount: 'user-1' });
    await settle();
    await release();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(taken).toHaveLength(1);
  });

  // Development's Strict Mode mounts the form, unmounts it and mounts it again before the read is
  // back: an answer gated on the first run's cleanup never reached the form.
  it('puts its one read on the form under Strict Mode', async () => {
    const fetchMock = stubSource();
    const { result, taken } = renderRead({ strict: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(taken.map((answer) => answer.bundle)).toEqual([BUNDLE]);
  });

  it('waits for a session before it reads', async () => {
    const fetchMock = stubSource();
    const { result, rerender, taken } = renderRead({ props: { pageToken: null } });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);

    rerender({ pageToken: 'page-token', formAccount: 'user-1' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taken).toHaveLength(1);
  });

  it('drops an answer that lands once the form has left the page', async () => {
    const { hold, release } = held();
    const fetchMock = stubSource({ hold });
    const { unmount, taken } = renderRead();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();
    await release();
    await settle();

    expect(taken).toEqual([]);
  });

  describe('its session', () => {
    // Back can draw the page again from Next's cache with the session it was first drawn with,
    // expired since. The browser's own session, renewed as it nears its end, is the account's too.
    it('reads with the browser’s own session when it is the form’s account, over the page’s', async () => {
      browser.session = { access_token: 'fresh-token', user: { id: 'user-1' } };
      const fetchMock = stubSource();
      const { result } = renderRead({ props: { pageToken: 'expired-token' } });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(tokensOf(fetchMock)).toEqual(['Bearer fresh-token']);
    });

    // Never another account's session (one signed in from another tab); and the page's own where the
    // browser holds none: the remix source answers as its reader.
    it.each([
      ['another account', { access_token: 'token-user-2', user: { id: 'user-2' } }],
      ['no one', null],
    ])('reads with the page’s session when the browser’s belongs to %s', async (_case, session) => {
      browser.session = session;
      const fetchMock = stubSource();
      const { result } = renderRead();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(tokensOf(fetchMock)).toEqual(['Bearer page-token']);
    });
  });

  describe('a read that failed', () => {
    it.each([
      ['a 5xx', { status: 503, body: { error: 'Service unavailable' } }],
      ['a 429', { status: 429, body: { error: 'Too many requests' } }],
      ['a revoked session', { status: 401, body: { error: 'Unauthorized' } }],
      ['the network', new TypeError('Failed to fetch')],
    ])('is said, and final until Try again, after %s', async (_case, failure) => {
      const fetchMock = stubSource({ failures: [failure as Answer] });
      const { result, rerender, taken } = renderRead();

      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
      expect(result.current.loading).toBe(false);
      expect(result.current.canRetry).toBe(true);
      expect(taken).toEqual([]);

      // A renewed token reads nothing: main's token-driven re-read put the original over the
      // creator's work, up to an hour later.
      rerender({ pageToken: 'renewed-token', formAccount: 'user-1' });
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // A refusal of the remix itself answers the same again: Try again would only say it twice
    // (2026-11-06 review). The warning stays.
    it.each([
      ['a 403', { status: 403, body: { error: 'Forbidden' } }],
      ['a 404', { status: 404, body: { error: 'Not found' } }],
    ])('is said with no Try again after %s, which a later read would answer the same', async (_case, failure) => {
      const fetchMock = stubSource({ failures: [failure as Answer] });
      const { result } = renderRead();

      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
      expect(result.current.canRetry).toBe(false);
      act(() => result.current.retry());
      await settle();
      expect(result.current.loading).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // In the browser's console too, as each creator's own read said it before the hook (2026-11-06 review).
    it('says the failure in the browser’s console', async () => {
      const failure = new TypeError('Failed to fetch');
      stubSource({ failures: [failure] });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      onTestFinished(() => consoleError.mockRestore());
      const { result } = renderRead();

      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
      expect(consoleError).toHaveBeenCalledWith('Error fetching remix:', failure);
    });

    it('reads once more on Try again, under the form’s account, and puts that answer on the form', async () => {
      const fetchMock = stubSource({ failures: [{ status: 503, body: { error: 'Service unavailable' } }] });
      const { result, taken } = renderRead();
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      // The account's session was renewed meanwhile.
      browser.session = { access_token: 'renewed-token', user: { id: 'user-1' } };
      act(() => result.current.retry());
      expect(result.current.loading).toBe(true);
      expect(result.current.failureWarning).toBeNull();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(taken.map((answer) => answer.bundle)).toEqual([BUNDLE]);
      expect(result.current.failureWarning).toBeNull();
      expect(tokensOf(fetchMock)).toEqual(['Bearer page-token', 'Bearer renewed-token']);
    });

    it('reads Try again with the page’s session when the browser’s has become another account’s', async () => {
      const fetchMock = stubSource({ failures: [new TypeError('Failed to fetch')] });
      const { result } = renderRead();
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      browser.session = { access_token: 'token-user-2', user: { id: 'user-2' } };
      act(() => result.current.retry());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(tokensOf(fetchMock)).toEqual(['Bearer page-token', 'Bearer page-token']);
    });

    it('says a failed Try again, and offers it again', async () => {
      const fetchMock = stubSource({ failures: [{ status: 503, body: {} }, { status: 500, body: {} }] });
      const { result, taken } = renderRead();
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      act(() => result.current.retry());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
      act(() => result.current.retry());

      await waitFor(() => expect(taken).toHaveLength(1));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // The words are read against the prompt as the first read began: words typed after the failure
    // are the creator's own too, and the prompt the form opened on is not.
    it.each([
      ['words typed after the failure', 'My own words', true],
      ['the prompt the form opened on', 'Describe the movement', false],
    ])('reads %s against the prompt as the first read began', async (_case, promptAtRetry, typed) => {
      stubSource({ failures: [new TypeError('Failed to fetch')] });
      const { result, promptRef, taken } = renderRead({ prompt: 'Describe the movement' });
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      promptRef.current = promptAtRetry;
      act(() => result.current.retry());

      await waitFor(() => expect(taken).toHaveLength(1));
      expect(taken[0].prompt).toBe(typed);
    });

    it('does nothing on Try again unless the last read failed', async () => {
      const { hold, release } = held();
      const fetchMock = stubSource({ hold });
      const { result, taken } = renderRead();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      act(() => result.current.retry());
      await release();
      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.retry());
      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(taken).toHaveLength(1);
    });

    // A source read halfway is no restore: it is said as a failed read, and Try again reads it whole.
    it('takes an answer the form could not take for a failed read', async () => {
      stubSource();
      const onSource = vi.fn().mockImplementationOnce(() => {
        throw new Error('A bug in the creator’s restore');
      });
      const { result, taken } = renderRead({ onSource });
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.failureWarning).toBeNull();
      expect(taken).toHaveLength(2);
    });
  });

  describe('what the creator set by hand before the answer', () => {
    it('is told to the form, field by field', async () => {
      const { hold, release } = held();
      stubSource({ hold });
      const { result, taken } = renderRead();

      act(() => result.current.noteEdit('model'));
      await release();

      await waitFor(() => expect(taken).toHaveLength(1));
      expect(taken[0]).toMatchObject({ model: true, aspectRatio: false, prompt: false });
    });

    it('includes what was set after a failed read, for Try again’s answer', async () => {
      stubSource({ failures: [{ status: 503, body: {} }] });
      const { result, taken } = renderRead();
      await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));

      act(() => result.current.noteEdit('aspectRatio'));
      act(() => result.current.retry());

      await waitFor(() => expect(taken).toHaveLength(1));
      expect(taken[0]).toMatchObject({ model: false, aspectRatio: true });
    });
  });
});

// The session rule and the fetch both of a remix page's readers go through: the form's one read and
// the renewal of its links (`useRemixLinkRenewal`).
// Owner, 2026-11-13: a shelf card (and any link to a remix) whose post keeps its remix behind a
// free recipe opens a creator that takes the recipe on the way, as the feed card's Remix and the
// post page's do: the read is refused for the recipe, the recipe is taken, and the read is asked again.
describe('useRemixSourceRead, for a remix behind a free recipe', () => {
  const UNLOCK_REQUIRED = { status: 403, body: { error: 'Unlock this post to remix it.', code: 'REMIX_UNLOCK_REQUIRED' } };

  /** The remix source and the free claim, each answering from its own queue; every request in order. */
  function stubSourceAndClaim({ source, claim }: { source: Answer[]; claim: Answer[] }) {
    const sources = [...source];
    const claims = [...claim];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      const queue = String(input).endsWith('/unlock-free') ? claims : sources;
      const answer = queue.shift() ?? { status: 200, body: BUNDLE };
      if (answer instanceof Error) throw answer;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const requestsOf = (fetchMock: ReturnType<typeof stubSourceAndClaim>) => fetchMock.mock.calls
    .map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`);

  beforeEach(() => {
    browser.session = { access_token: 'page-token', user: { id: 'user-1' } };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes the free recipe, reads again, and puts that answer on the form, once', async () => {
    const fetchMock = stubSourceAndClaim({ source: [UNLOCK_REQUIRED], claim: [{ status: 200, body: { success: true } }] });
    const { result, taken } = renderRead();

    await waitFor(() => expect(taken).toHaveLength(1));
    expect(requestsOf(fetchMock)).toEqual([
      'GET /api/remix-source?id=gen-1&postId=post-1',
      'POST /api/posts/post-1/resource-bundle/unlock-free',
      'GET /api/remix-source?id=gen-1&postId=post-1',
    ]);
    // Under the form's account, as the reads are.
    expect(tokensOf(fetchMock as never)).toEqual(['Bearer page-token', 'Bearer page-token', 'Bearer page-token']);
    expect(taken[0].bundle).toEqual(BUNDLE);
    expect(result.current.loading).toBe(false);
    expect(result.current.failureWarning).toBeNull();
  });

  it('holds the notice’s placeholder until the second read answers', async () => {
    const claim = held();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/unlock-free')) {
        await claim.hold;
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      const first = fetchMock.mock.calls.filter(([asked]) => String(asked).startsWith('/api/remix-source')).length === 1;
      return (first
        ? { ok: false, status: 403, json: async () => UNLOCK_REQUIRED.body }
        : { ok: true, status: 200, json: async () => BUNDLE }) as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, taken } = renderRead();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.failureWarning).toBeNull();

    await claim.release();
    await waitFor(() => expect(taken).toHaveLength(1));
    expect(result.current.loading).toBe(false);
  });

  // A paid recipe, a blocked pair, a recipe since retired: the claim is refused, and the remix
  // stays refused as it was, with no Try again (a later read would answer the same).
  it('says the remix’s own refusal when the recipe cannot be taken, and reads no third time', async () => {
    const fetchMock = stubSourceAndClaim({
      source: [UNLOCK_REQUIRED],
      claim: [{ status: 400, body: { error: 'This bundle requires payment.' } }],
    });
    const { result, taken } = renderRead();

    await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
    expect(result.current.canRetry).toBe(false);
    expect(taken).toEqual([]);
    expect(requestsOf(fetchMock)).toEqual([
      'GET /api/remix-source?id=gen-1&postId=post-1',
      'POST /api/posts/post-1/resource-bundle/unlock-free',
    ]);
  });

  // The claim itself could not be made: nothing says the recipe cannot be taken, so the failure
  // is one a later try can get past, as a failed read is (2026-11-13 review).
  it.each([
    ['a 429', { status: 429, body: { error: 'Too many recipes. Try again shortly.' } }],
    ['a 5xx', { status: 500, body: { error: 'Failed to get the free recipe.' } }],
    ['the network', new TypeError('Failed to fetch')],
  ])('offers Try again when the claim fails with %s, and takes the recipe on that try', async (_case, failure) => {
    const fetchMock = stubSourceAndClaim({
      source: [UNLOCK_REQUIRED, UNLOCK_REQUIRED],
      claim: [failure as Answer, { status: 200, body: { success: true } }],
    });
    const { result, taken } = renderRead();

    await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
    expect(result.current.canRetry).toBe(true);
    expect(taken).toEqual([]);

    act(() => result.current.retry());
    await waitFor(() => expect(taken).toHaveLength(1));
    expect(requestsOf(fetchMock)).toEqual([
      'GET /api/remix-source?id=gen-1&postId=post-1',
      'POST /api/posts/post-1/resource-bundle/unlock-free',
      'GET /api/remix-source?id=gen-1&postId=post-1',
      'POST /api/posts/post-1/resource-bundle/unlock-free',
      'GET /api/remix-source?id=gen-1&postId=post-1',
    ]);
    expect(result.current.failureWarning).toBeNull();
  });

  it('takes the recipe once: a second refusal after the claim is final', async () => {
    const fetchMock = stubSourceAndClaim({
      source: [UNLOCK_REQUIRED, UNLOCK_REQUIRED],
      claim: [{ status: 200, body: { success: true } }],
    });
    const { result, taken } = renderRead();

    await waitFor(() => expect(result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
    expect(result.current.canRetry).toBe(false);
    expect(taken).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('takes nothing for any other refusal, or for a remix that names no post', async () => {
    const forbidden = stubSourceAndClaim({ source: [{ status: 403, body: { error: 'Forbidden' } }], claim: [] });
    const first = renderRead();
    await waitFor(() => expect(first.result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
    expect(requestsOf(forbidden)).toEqual(['GET /api/remix-source?id=gen-1&postId=post-1']);
    first.unmount();

    const noPost = stubSourceAndClaim({ source: [UNLOCK_REQUIRED], claim: [] });
    const promptRef = { current: '' };
    const second = renderHook(() => useRemixSourceRead<Field>({
      remixId: 'gen-1',
      remixPostId: null,
      pageToken: 'page-token',
      formAccount: 'user-1',
      promptRef,
      onSource: () => undefined,
    }));
    await waitFor(() => expect(second.result.current.failureWarning).toBe(REMIX_RESTORE_WARNING));
    expect(requestsOf(noPost)).toEqual(['GET /api/remix-source?id=gen-1']);
  });

  it('drops the second read’s answer once the form has left the page', async () => {
    const claim = held();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/unlock-free')) {
        await claim.hold;
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      return { ok: false, status: 403, json: async () => UNLOCK_REQUIRED.body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { taken, unmount } = renderRead();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    unmount();
    await claim.release();
    await settle();

    // Nothing read for a form that is gone, and nothing put on it.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(taken).toEqual([]);
  });
});

describe('readRemixSource', () => {
  beforeEach(() => {
    browser.session = { access_token: 'browser-token', user: { id: 'user-1' } };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const read = (pageToken: string | null, formAccount: string | null = 'user-1') => (
    readRemixSource({ id: 'gen-1', postId: 'post-1' }, { formAccount, pageToken })
  );

  it('reads with the browser’s own session where it is the form’s account', async () => {
    const fetchMock = stubSource();
    await expect(read('page-token')).resolves.toEqual(BUNDLE);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(['/api/remix-source?id=gen-1&postId=post-1']);
    expect(tokensOf(fetchMock)).toEqual(['Bearer browser-token']);
  });

  it.each([
    ['another account', { access_token: 'token-user-2', user: { id: 'user-2' } }],
    ['no one', null],
  ])('reads with the page’s session where the browser’s belongs to %s', async (_case, session) => {
    browser.session = session;
    const fetchMock = stubSource();
    await read('page-token');
    expect(tokensOf(fetchMock)).toEqual(['Bearer page-token']);
  });

  it('reads nothing where there is no session of the form’s account to read with', async () => {
    browser.session = { access_token: 'token-user-2', user: { id: 'user-2' } };
    const fetchMock = stubSource();
    await expect(read(null)).rejects.toThrow();
    // A page with no account of its own is no reader either.
    await expect(read(null, null)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a refusal', async () => {
    stubSource({ failures: [{ status: 401, body: { error: 'Unauthorized' } }] });
    await expect(read('page-token')).rejects.toThrow('Unauthorized');
  });

  // The renewal gives a read up after its timeout; one given up while the session was read asks nothing.
  it('asks nothing once its signal has given the read up, and hands the signal to the request', async () => {
    const fetchMock = stubSource();
    const givenUp = new AbortController();
    givenUp.abort();
    await expect(readRemixSource({ id: 'gen-1', postId: null }, { formAccount: 'user-1', pageToken: 'page-token' }, givenUp.signal))
      .rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const live = new AbortController();
    await readRemixSource({ id: 'gen-1', postId: null }, { formAccount: 'user-1', pageToken: 'page-token' }, live.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(live.signal);
  });
});
