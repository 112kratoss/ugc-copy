// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One stable object: a fresh `api` per render would read as a new client to the query.
const authState = vi.hoisted(() => ({
  identityUserId: 'user-1' as string | null,
  refreshProfile: vi.fn(async () => undefined),
  api: { listGenerations: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

import { activeGenerationsQueryKey, useActiveGenerationCount } from '../lib/use-active-generations';

const KEY = activeGenerationsQueryKey('user-1');

/** One `detail=status` page whose rows are in these states. */
function answer(...statuses: string[]) {
  return { generations: statuses.map((status, index) => ({ id: `gen-${index}`, status })) };
}

/** The answers the status list gives, one per read, the last repeated. */
function answers(...pages: ReturnType<typeof answer>[]) {
  authState.api.listGenerations.mockImplementation(async () => (pages.length > 1 ? pages.shift() : pages[0]));
}

function CountProbe({ seen }: { seen: number[] }) {
  seen.push(useActiveGenerationCount());
  return null;
}

const mounted: renderer.ReactTestRenderer[] = [];

/** Lets the mocked read answer and the observers render what it said. */
async function flush() {
  for (let pass = 0; pass < 5; pass += 1) {
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(element: (mode: 'visible' | 'hidden') => React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element('visible')); });
  mounted.push(tree);
  await flush();
  return tree;
}

async function readAgain(client: QueryClient) {
  await renderer.act(async () => { await client.refetchQueries({ queryKey: KEY }); });
  await flush();
}

describe('the in-flight count', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    authState.identityUserId = 'user-1';
    authState.refreshProfile.mockClear();
    authState.api.listGenerations.mockReset();
  });

  // The count polls every 10 s while above zero; nothing of one case may poll into the next.
  afterEach(() => {
    renderer.act(() => { for (const tree of mounted.splice(0)) tree.unmount(); });
    client.clear();
  });

  it('reads the balance again when the last run in flight settles, since a failure returned its credits', async () => {
    answers(answer('processing', 'waiting'), answer('failed', 'succeeded'));
    const seen: number[] = [];
    await mount(() => <QueryClientProvider client={client}><CountProbe seen={seen} /></QueryClientProvider>);
    expect(seen.at(-1)).toBe(2);
    expect(authState.refreshProfile).not.toHaveBeenCalled();

    await readAgain(client);

    expect(seen.at(-1)).toBe(0);
    expect(authState.refreshProfile).toHaveBeenCalledTimes(1);
    expect(authState.api.listGenerations).toHaveBeenLastCalledWith(false, { limit: 20, detail: 'status' });
  });

  it('leaves the balance alone on a first answer of zero, on a start, and while a run is still going', async () => {
    answers(answer('succeeded'), answer('pending'), answer('processing', 'waiting'), answer('processing', 'failed'));
    const seen: number[] = [];
    await mount(() => <QueryClientProvider client={client}><CountProbe seen={seen} /></QueryClientProvider>);
    expect(seen.at(-1)).toBe(0);

    await readAgain(client);
    expect(seen.at(-1)).toBe(1);
    await readAgain(client);
    expect(seen.at(-1)).toBe(2);
    await readAgain(client);
    expect(seen.at(-1)).toBe(1);

    expect(authState.refreshProfile).not.toHaveBeenCalled();
  });

  it('reads it once for the tab bar and Home together, and again only on the next drop', async () => {
    answers(answer('processing'), answer('failed'), answer('waiting'), answer('succeeded'));
    const bar: number[] = [];
    const home: number[] = [];
    await mount(() => (
      <QueryClientProvider client={client}>
        <CountProbe seen={bar} />
        <CountProbe seen={home} />
      </QueryClientProvider>
    ));
    expect([bar.at(-1), home.at(-1)]).toEqual([1, 1]);

    await readAgain(client);
    expect([bar.at(-1), home.at(-1)]).toEqual([0, 0]);
    expect(authState.refreshProfile).toHaveBeenCalledTimes(1);

    await readAgain(client);
    await readAgain(client);
    expect(authState.refreshProfile).toHaveBeenCalledTimes(2);
  });

  it('asks nothing extra when every effect runs again, as a hidden Activity shown again does', async () => {
    answers(answer('processing'), answer('failed'));
    const seen: number[] = [];
    const inActivity = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <React.Activity mode={mode}><CountProbe seen={seen} /></React.Activity>
      </QueryClientProvider>
    );
    const tree = await mount(inActivity);
    expect(seen.at(-1)).toBe(1);

    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    expect(seen.at(-1)).toBe(1);
    expect(authState.refreshProfile).not.toHaveBeenCalled();

    await readAgain(client);
    expect(seen.at(-1)).toBe(0);
    expect(authState.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it('does not ask at all without an identity', async () => {
    authState.identityUserId = null;
    const seen: number[] = [];
    await mount(() => <QueryClientProvider client={client}><CountProbe seen={seen} /></QueryClientProvider>);

    expect(seen.at(-1)).toBe(0);
    expect(authState.api.listGenerations).not.toHaveBeenCalled();
    expect(authState.refreshProfile).not.toHaveBeenCalled();
  });
});
