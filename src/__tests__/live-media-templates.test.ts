// @vitest-environment node
// (The read's deadline is Node's own AbortSignal.timeout, as on the server.)
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasLiveMediaTemplates, LIVE_TEMPLATES_READ_TIMEOUT_MS, loadTemplatesLive } from '@/lib/live-media-templates';
import { listActiveMediaTemplatesPage } from '@/lib/media-template-service';

/**
 * The creators' ways into /templates (the Templates tile beside Enhance and "Browse templates"
 * under "Start from a post"), the launchpad's catalog card and the owner's "Browse templates" are
 * drawn only while the catalog lists a template: the web sweep of 2026-11-17 followed them to
 * "No templates are live yet". The question is the catalog's own.
 */

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.client,
}));

type Call = [method: string, ...args: unknown[]];

/**
 * A Supabase client whose every read records each call made on it, whatever the method, per
 * table, and answers `answer`.
 */
function recordingClient(answer: { data: unknown[] | null; error: unknown }) {
  const calls: Record<string, Call[]> = {};
  const from = vi.fn((table: string) => {
    const tableCalls = (calls[table] ??= []);
    const query: object = new Proxy({}, {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(answer).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          tableCalls.push([String(property), ...args]);
          return query;
        };
      },
    });
    return query;
  });
  return { client: { from } as never, from, calls };
}

// What a read asks for, as opposed to how much of it, in what order, and how it is sent. The page
// read's `.or` is its cursor's, and it is given none here. Anything else either read applies (a
// new `.in`, `.or`, `.is`, `.neq`…) is a filter, and must be on both.
const NOT_FILTERS = new Set(['select', 'order', 'limit', 'retry', 'abortSignal']);
const filtersOf = (calls: Call[]) => calls.filter(([method]) => !NOT_FILTERS.has(method));

afterEach(() => {
  mocks.client = null;
  vi.restoreAllMocks();
});

describe('whether a template is live', () => {
  it('asks for one template the public catalog would list, once and on a deadline', async () => {
    const { client, from, calls } = recordingClient({ data: [{ id: 'template-1' }], error: null });

    await expect(hasLiveMediaTemplates(client)).resolves.toBe(true);

    expect(from).toHaveBeenCalledTimes(1);
    expect(calls.templates).toEqual([
      ['select', 'id'],
      ['eq', 'status', 'active'],
      ['eq', 'is_active', true],
      ['not', 'active_version_id', 'is', null],
      ['not', 'creator_user_id', 'is', null],
      ['limit', 1],
      ['retry', false],
      ['abortSignal', expect.any(AbortSignal)],
    ]);
  });

  it('answers no for an empty catalog', async () => {
    await expect(hasLiveMediaTemplates(recordingClient({ data: [], error: null }).client)).resolves.toBe(false);
    await expect(hasLiveMediaTemplates(recordingClient({ data: null, error: null }).client)).resolves.toBe(false);
  });

  // A failed read says nothing about the catalog: thrown, the creators' data cache never keeps it.
  it('throws a failed read rather than answering no', async () => {
    const failure = { message: 'connection refused' };
    await expect(hasLiveMediaTemplates(recordingClient({ data: null, error: failure }).client)).rejects.toBe(failure);
  });

  // The tile must never be drawn for a template the catalog leaves out, or hidden for one it lists:
  // any filter added to either read and not to the other fails here.
  it('filters templates exactly as the catalog page lists them', async () => {
    const flag = recordingClient({ data: [], error: null });
    const catalog = recordingClient({ data: [], error: null });

    await hasLiveMediaTemplates(flag.client);
    await listActiveMediaTemplatesPage(catalog.client);

    expect(filtersOf(catalog.calls.templates).length).toBeGreaterThan(0);
    expect(filtersOf(flag.calls.templates)).toEqual(filtersOf(catalog.calls.templates));
  });
});

describe('the pages\' read of it', () => {
  it('answers what the catalog says, and no when it cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.client = recordingClient({ data: [{ id: 'template-1' }], error: null }).client;
    await expect(loadTemplatesLive()).resolves.toBe(true);

    mocks.client = recordingClient({ data: [], error: null }).client;
    await expect(loadTemplatesLive()).resolves.toBe(false);

    mocks.client = recordingClient({ data: null, error: { message: 'connection refused' } }).client;
    await expect(loadTemplatesLive()).resolves.toBe(false);
  });
});

/**
 * The flag only decides whether a link is drawn, and a page waits for it (a remix waits before
 * its sign-in check), so a database that is down or slow answers no at once rather than after
 * supabase-js's retries (1, 2 and 4 seconds) or never. Through a real client, as the server
 * sends it.
 */
describe('a catalog that cannot answer', () => {
  /** Settles within `ms`, or says it did not. */
  function settlesWithin<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise.then(() => 'answered', () => 'failed'),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms)),
    ]);
  }

  function clientWith(fetch: typeof globalThis.fetch) {
    return createClient('https://catalog.example.test', 'test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch },
    });
  }

  it('answers once, with no retries, when the network fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(settlesWithin(hasLiveMediaTemplates(clientWith(fetch)), 500)).resolves.toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a read that never answers at its deadline', async () => {
    expect(LIVE_TEMPLATES_READ_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));

    await expect(settlesWithin(hasLiveMediaTemplates(clientWith(fetch)), LIVE_TEMPLATES_READ_TIMEOUT_MS + 1_000))
      .resolves.toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
