import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemixSourceBundle } from '@/lib/remix-source';
import { REMIX_RESTORE_WARNING } from '@/lib/remix-source-client';
import { useRemixSourceRead } from '@/lib/use-remix-source-read';

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

function strictMode({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

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
    { initialProps: { pageToken: 'page-token', formAccount: 'user-1', ...props }, wrapper: strict ? strictMode : undefined },
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
      expect(taken).toEqual([]);

      // A renewed token reads nothing: main's token-driven re-read put the original over the
      // creator's work, up to an hour later.
      rerender({ pageToken: 'renewed-token', formAccount: 'user-1' });
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
