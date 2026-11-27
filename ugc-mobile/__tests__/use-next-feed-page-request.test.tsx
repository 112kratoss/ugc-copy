(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAskAgainAfterCooldown, useNextFeedPageRequest } from '../lib/use-next-feed-page-request';

type Options = Parameters<typeof useNextFeedPageRequest>[0];
type Requests = ReturnType<typeof useNextFeedPageRequest>;

const COOLDOWN = 800;
const fetchNextPage = vi.fn(() => Promise.resolve());
const latest: { current: Requests | null } = { current: null };
let tree: renderer.ReactTestRenderer | null = null;

function Probe(options: Options) {
  latest.current = useNextFeedPageRequest(options);
  return null;
}

const base: Options = {
  list: 'Creations:active',
  enabled: true,
  cooldownMs: COOLDOWN,
  hasNextPage: true,
  isBusy: false,
  isFetchNextPageError: false,
  pageCount: 1,
  fetchNextPage,
};

const settle = (work: () => void) => renderer.act(async () => { work(); });
const show = (options: Partial<Options>) => settle(() => {
  const element = <Probe {...base} {...options} />;
  if (tree) tree.update(element);
  else tree = renderer.create(element);
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchNextPage.mockClear();
});

afterEach(() => {
  renderer.act(() => { tree?.unmount(); });
  tree = null;
  vi.useRealTimers();
});

describe('useNextFeedPageRequest', () => {
  // The page a Retry asked for clears the error as it lands; that is no refresh
  // taking the footer away, so nothing more is asked for on its account.
  it('asks nothing more when the page a Retry asked for lands', async () => {
    await show({});
    await settle(() => latest.current!.requestNextPage());
    await show({ isFetchNextPageError: true });
    await settle(() => { vi.advanceTimersByTime(COOLDOWN * 2); });
    await settle(() => latest.current!.retryNextPage());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);

    await show({ isFetchNextPageError: false, pageCount: 2 });
    await settle(() => { vi.advanceTimersByTime(COOLDOWN * 2); });

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  // Another list's query has its own page count and its own error: one that
  // has none is not the last list's error cleared, and the ask put off for the
  // last list is not this one's.
  it('starts another list afresh, dropping what was put off for the last', async () => {
    await show({});
    await settle(() => latest.current!.requestNextPage());
    await show({ isFetchNextPageError: true });
    await show({ pageCount: 2 });
    await settle(() => latest.current!.requestNextPage());

    await show({ list: 'Posts:active', pageCount: 2 });
    await settle(() => { vi.advanceTimersByTime(COOLDOWN * 2); });

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    await settle(() => latest.current!.requestNextPage());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  it('forgets what was asked when the list is read again from its first page', async () => {
    await show({});
    await settle(() => latest.current!.requestNextPage());
    await settle(() => latest.current!.requestNextPage());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    await settle(() => latest.current!.resetPageRequests());
    await settle(() => latest.current!.requestNextPage());

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});

// For the screens that keep the gate's refs themselves (Home, Explore, the
// creator page): a request the gate put off is asked again once, as its wait
// ends, through the request the latest render pointed the ref at.
describe('useAskAgainAfterCooldown', () => {
  const askAgain: { current: ReturnType<typeof useAskAgainAfterCooldown> | null } = { current: null };
  function AskProbe({ ask }: { ask: () => void }) {
    const askRef = React.useRef(ask);
    React.useEffect(() => {
      askRef.current = ask;
    });
    askAgain.current = useAskAgainAfterCooldown(askRef);
    return null;
  }
  const mount = (ask: () => void) => settle(() => {
    const element = <AskProbe ask={ask} />;
    if (tree) tree.update(element);
    else tree = renderer.create(element);
  });

  it('asks once as the wait ends, through the latest request', async () => {
    const first = vi.fn();
    const latestAsk = vi.fn();
    await mount(first);
    await settle(() => askAgain.current!.askAgainIn(500));
    await mount(latestAsk);
    await settle(() => { vi.advanceTimersByTime(499); });
    expect(latestAsk).not.toHaveBeenCalled();
    await settle(() => { vi.advanceTimersByTime(1); });
    expect(first).not.toHaveBeenCalled();
    expect(latestAsk).toHaveBeenCalledTimes(1);
    await settle(() => { vi.advanceTimersByTime(COOLDOWN * 4); });
    expect(latestAsk).toHaveBeenCalledTimes(1);
  });

  it('keeps one ask pending, and none once cancelled or unmounted', async () => {
    const ask = vi.fn();
    await mount(ask);
    await settle(() => {
      askAgain.current!.askAgainIn(300);
      askAgain.current!.askAgainIn(600);
    });
    await settle(() => { vi.advanceTimersByTime(600); });
    expect(ask).toHaveBeenCalledTimes(1);

    await settle(() => askAgain.current!.askAgainIn(300));
    await settle(() => askAgain.current!.cancel());
    await settle(() => { vi.advanceTimersByTime(300); });
    expect(ask).toHaveBeenCalledTimes(1);

    await settle(() => askAgain.current!.askAgainIn(300));
    renderer.act(() => { tree?.unmount(); });
    tree = null;
    await settle(() => { vi.advanceTimersByTime(300); });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
