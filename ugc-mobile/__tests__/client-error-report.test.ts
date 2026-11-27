import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  CLIENT_ERROR_LIMITS,
  configureClientErrorStore,
  installGlobalErrorHandlers,
  type ClientErrorReportBody,
  reportClientError,
  resetClientErrorReportsForTests,
  setClientErrorReporter,
} from '../lib/client-error-report';

// Audit 2026-11-27: errors on phones reached nobody. The app's boundary, its global JS handler and
// its unhandled-rejection tracker hand every error to this one reporter, which sends it to
// POST /api/mobile/client-errors with no vendor in between.
const contract = mobileApiContract.endpoints.reportClientError;
const context = { route: '/showcase/post-1', appVersion: '0.1.9', updateId: 'a17f193a', platform: 'android' as const };

function reporter(send = vi.fn(async (_report: unknown) => undefined)) {
  setClientErrorReporter({ send, context: () => context });
  return send;
}

async function settle() {
  for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  resetClientErrorReportsForTests({ dev: false });
});

afterEach(() => {
  resetClientErrorReportsForTests({ dev: false });
});

describe('the client error reporter', () => {
  it('sends the contract\'s fields, and nothing else', async () => {
    const send = reporter();
    const error = new TypeError("Cannot read property 'id' of undefined");
    error.stack = 'TypeError: ...\n    at PostCard';

    reportClientError(error, { componentStack: '\n    in PostCard', fatal: false });
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(contract.request).sort());
    expect(sent).toEqual({
      message: "TypeError: Cannot read property 'id' of undefined",
      stack: 'TypeError: ...\n    at PostCard',
      componentStack: '\n    in PostCard',
      fatal: false,
      ...context,
    });
  });

  it('truncates to the contract\'s limits', async () => {
    expect(CLIENT_ERROR_LIMITS).toEqual(contract.limits);
    const send = reporter();
    const error = new Error('m'.repeat(900));
    error.stack = 's'.repeat(9_000);

    reportClientError(error, { componentStack: 'c'.repeat(3_000), fatal: true });
    await settle();

    const sent = send.mock.calls[0][0] as { message: string; stack: string; componentStack: string };
    expect(sent.message.length).toBe(500);
    expect(sent.stack.length).toBe(4_000);
    expect(sent.componentStack.length).toBe(2_000);
  });

  it('sends each distinct error once per session, and five at most', async () => {
    const send = reporter();
    const same = new Error('same');
    reportClientError(same, { fatal: false });
    reportClientError(same, { fatal: false });
    for (let index = 0; index < 10; index += 1) reportClientError(new Error(`error ${index}`), { fatal: false });
    await settle();

    expect(send).toHaveBeenCalledTimes(CLIENT_ERROR_LIMITS.perSession);
    expect((send.mock.calls[0][0] as { message: string }).message).toBe('Error: same');
  });

  it('is silent in development', async () => {
    resetClientErrorReportsForTests({ dev: true });
    const send = reporter();
    reportClientError(new Error('dev only'), { fatal: false });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws: not on a failed send, a throwing context, or an odd value', async () => {
    setClientErrorReporter({ send: () => { throw new Error('offline'); }, context: () => context });
    expect(() => reportClientError(new Error('a'), { fatal: false })).not.toThrow();
    setClientErrorReporter({ send: async () => { throw new Error('offline'); }, context: () => context });
    expect(() => reportClientError(new Error('b'), { fatal: false })).not.toThrow();
    setClientErrorReporter({ send: vi.fn(), context: () => { throw new Error('no route'); } });
    expect(() => reportClientError(new Error('c'), { fatal: false })).not.toThrow();
    expect(() => reportClientError(undefined, { fatal: false })).not.toThrow();
    expect(() => reportClientError({ toString: () => { throw new Error('bad'); } }, { fatal: false })).not.toThrow();
    await settle();
  });

  it('keeps what was caught before the reporter was set, and sends it once it is', async () => {
    reportClientError(new Error('at launch'), { fatal: true });
    const send = reporter();
    await settle();
    expect((send.mock.calls[0][0] as { message: string; fatal: boolean })).toMatchObject({ message: 'Error: at launch', fatal: true });
  });

  // A plain network failure says nothing about the app, and five of them would use up the session.
  it('does not report plain network failures', async () => {
    const send = reporter();
    const aborted = new Error('Aborted');
    aborted.name = 'AbortError';
    const apiOffline = Object.assign(new Error('Network request failed. Please check your connection and try again.'), { name: 'ApiError', status: 0 });
    for (const error of [new TypeError('Network request failed'), aborted, apiOffline, new Error('Request timed out after 30000ms')]) {
      reportClientError(error, { fatal: false });
    }
    reportClientError(new Error('a real one'), { fatal: false });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as { message: string }).message).toBe('Error: a real one');
  });

  it('sends a route\'s path alone, never its query', async () => {
    const send = vi.fn(async (_report: unknown) => undefined);
    setClientErrorReporter({ send, context: () => ({ ...context, route: '/search?q=what I typed' }) });
    reportClientError(new Error('x'), { fatal: false });
    await settle();
    expect((send.mock.calls[0][0] as { route: string }).route).toBe('/search');
  });
});

describe('the global handlers', () => {
  it('hands a JS error to the reporter and still calls the handler before it', async () => {
    const send = reporter();
    const previous = vi.fn();
    let installed: ((error: unknown, isFatal?: boolean) => void) | null = null;
    const errorUtils = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => { installed = handler; },
    };

    installGlobalErrorHandlers({ errorUtils, hermes: null });
    const error = new Error('boom');
    // A fatal one is kept on the device instead (the next test); a non-fatal one is sent now.
    installed!(error, false);
    await settle();

    expect(previous).toHaveBeenCalledWith(error, false);
    expect(send.mock.calls[0][0]).toMatchObject({ message: 'Error: boom', fatal: false });
  });

  // Audit review: a release build's handler ends the process on a fatal error, so a fetch started
  // then never lands. The report is kept on the device first, for a bounded time, and sent at the
  // next launch.
  it('keeps a fatal error on the device before the handler before it ends the app, and sends it next launch', async () => {
    vi.useFakeTimers();
    try {
      const saved: ClientErrorReportBody[] = [];
      let finishSave!: () => void;
      const store = {
        save: vi.fn((bodies: ClientErrorReportBody[]) => new Promise<void>((resolve) => {
          finishSave = () => { saved.push(...bodies); resolve(); };
        })),
        peek: vi.fn(async () => [...saved]),
        drop: vi.fn(async (sent: ClientErrorReportBody[]) => {
          for (const body of sent) saved.splice(saved.indexOf(body), 1);
        }),
      };
      configureClientErrorStore(store, () => context);
      const previous = vi.fn();
      let installed: ((error: unknown, isFatal?: boolean) => void) | null = null;
      installGlobalErrorHandlers({
        errorUtils: { getGlobalHandler: () => previous, setGlobalHandler: (handler) => { installed = handler; } },
        hermes: null,
      });

      installed!(new Error('fatal boom'), true);
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(previous).not.toHaveBeenCalled();
      finishSave();
      await vi.advanceTimersByTimeAsync(0);
      expect(previous).toHaveBeenCalledTimes(1);
      expect(saved).toEqual([expect.objectContaining({ message: 'Error: fatal boom', fatal: true, route: context.route })]);

      // The next launch, offline: the send fails and the report stays on the device.
      resetClientErrorReportsForTests({ dev: false });
      configureClientErrorStore(store, () => context);
      reporter(vi.fn(async (_report: unknown) => { throw new Error('Network request failed'); }));
      await vi.advanceTimersByTimeAsync(0);
      expect(saved).toHaveLength(1);

      // The launch after, online: sent, and only then let go of.
      resetClientErrorReportsForTests({ dev: false });
      configureClientErrorStore(store, () => context);
      const send = reporter();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'Error: fatal boom', fatal: true }));
      expect(saved).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The reporter is set again whenever the API client changes (a sign-in): what a fatal error kept
  // is sent once per launch, not again by each new reporter.
  it('sends what an earlier launch kept once, however often the reporter is set', async () => {
    const kept: ClientErrorReportBody[] = [{ message: 'Error: kept', stack: null, componentStack: null, fatal: true, ...context }];
    let releaseFirst!: () => void;
    const store = {
      save: vi.fn(async () => undefined),
      peek: vi.fn(async () => [...kept]),
      drop: vi.fn(async (sent: ClientErrorReportBody[]) => {
        for (const body of sent) kept.splice(kept.indexOf(body), 1);
      }),
    };
    configureClientErrorStore(store, () => context);
    const first = vi.fn(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    setClientErrorReporter({ send: first, context: () => context });
    await settle();
    const second = vi.fn(async (_report: unknown) => undefined);
    setClientErrorReporter({ send: second, context: () => context });
    await settle();
    releaseFirst();
    await settle();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(store.peek).toHaveBeenCalledTimes(1);
  });

  it('ends the app as before when keeping the report hangs or throws, after at most a second', async () => {
    vi.useFakeTimers();
    try {
      configureClientErrorStore({ save: () => new Promise<void>(() => undefined), peek: async () => [], drop: async () => undefined }, () => context);
      const previous = vi.fn();
      let installed: ((error: unknown, isFatal?: boolean) => void) | null = null;
      installGlobalErrorHandlers({
        errorUtils: { getGlobalHandler: () => previous, setGlobalHandler: (handler) => { installed = handler; } },
        hermes: null,
      });
      installed!(new Error('hangs'), true);
      await vi.advanceTimersByTimeAsync(999);
      expect(previous).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(previous).toHaveBeenCalledTimes(1);

      configureClientErrorStore({ save: () => { throw new Error('disk'); }, peek: async () => [], drop: async () => undefined }, () => context);
      expect(() => installed!(new Error('throws'), true)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(previous).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(previous).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks unhandled rejections on Hermes as non-fatal reports', async () => {
    const send = reporter();
    let options: { allRejections: boolean; onUnhandled: (id: number, error: unknown) => void } | null = null;
    const hermes = { enablePromiseRejectionTracker: vi.fn((given: typeof options) => { options = given; }) };

    installGlobalErrorHandlers({ errorUtils: null, hermes });
    options!.onUnhandled(1, new Error('rejected'));
    await settle();

    expect(options!.allRejections).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({ message: 'Error: rejected', fatal: false });
  });

  it('installs once, and not at all in development', () => {
    const setGlobalHandler = vi.fn();
    const enablePromiseRejectionTracker = vi.fn();
    const errorUtils = { getGlobalHandler: () => vi.fn(), setGlobalHandler };

    installGlobalErrorHandlers({ errorUtils, hermes: { enablePromiseRejectionTracker } });
    installGlobalErrorHandlers({ errorUtils, hermes: { enablePromiseRejectionTracker } });
    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);

    resetClientErrorReportsForTests({ dev: true });
    setGlobalHandler.mockClear();
    installGlobalErrorHandlers({ errorUtils, hermes: { enablePromiseRejectionTracker } });
    expect(setGlobalHandler).not.toHaveBeenCalled();
  });
});
