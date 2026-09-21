import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/lib/backend-logger', () => ({ logBackendInfo: log }));

describe('bounded Showcase diagnostic timing', () => {
  let now = 0;
  beforeEach(() => {
    vi.resetModules();
    log.mockReset();
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubEnv('VERCEL_ENV', 'production');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('retains the first and slow loads, preserves results and records failed phase duration', async () => {
    const { createShowcaseLoadTiming } = await import('@/lib/showcase-load-timing');
    const first = createShowcaseLoadTiming('page_data');
    expect(await first.measure('feed', async () => { now = 30; return 42; })).toBe(42);
    first.finish();
    expect(log).toHaveBeenLastCalledWith('showcase_load_timing', {
      scope: 'page_data', firstLoad: true, elapsedMs: 30, phases: { feed: 30 },
    });
    createShowcaseLoadTiming('page_data').finish();
    expect(log).toHaveBeenCalledTimes(1);
    const slow = createShowcaseLoadTiming('feed_refill');
    await expect(slow.measure('load', async () => { now += 600; throw new Error('failed'); })).rejects.toThrow('failed');
    slow.record('hydrate', 10); slow.record('hydrate', 20);
    slow.finish();
    expect(log.mock.calls[1][1].phases).toEqual({ load: 600, hydrate: 30 });
  });

  it('caps each scope at twenty logs per minute and renews the allowance', async () => {
    const { createShowcaseLoadTiming } = await import('@/lib/showcase-load-timing');
    for (let i = 0; i < 30; i++) {
      const timer = createShowcaseLoadTiming('page_data'); now += 500; timer.finish();
    }
    expect(log).toHaveBeenCalledTimes(20);
    now += 60_000;
    const timer = createShowcaseLoadTiming('page_data'); now += 500; timer.finish();
    expect(log).toHaveBeenCalledTimes(21);
  });

  it('does not emit production diagnostics in preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const { createShowcaseLoadTiming } = await import('@/lib/showcase-load-timing');
    const timer = createShowcaseLoadTiming('page_data'); now += 1000; timer.finish();
    expect(log).not.toHaveBeenCalled();
  });
});
