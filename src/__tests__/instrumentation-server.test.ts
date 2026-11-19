import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureRequestError: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  configured: vi.fn(() => true),
  imported: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => {
  mocks.imported();
  return {
    init: mocks.init,
    captureRequestError: mocks.captureRequestError,
    captureException: mocks.captureException,
    flush: mocks.flush,
  };
});
vi.mock('@/lib/sentry-config', () => ({
  SENTRY_ERROR_SAMPLE_RATE: 1, SENTRY_TRACES_SAMPLE_RATE: 0,
  assertSentryConfigured: mocks.configured,
  resolveSentryDsn: () => 'private-dsn', resolveSentryEnvironment: () => 'production',
}));

type ProcessEvent = 'unhandledRejection' | 'uncaughtException';
type Listener = (...args: unknown[]) => void;
// One typed view of the two events, which Node's overloads cannot take as a union.
const processEvents = process as unknown as {
  listeners(event: ProcessEvent): Listener[];
  on(event: ProcessEvent, listener: Listener): void;
  off(event: ProcessEvent, listener: Listener): void;
};
const EVENTS: ProcessEvent[] = ['unhandledRejection', 'uncaughtException'];
let listenersBefore: Record<ProcessEvent, Listener[]>;

function addedListeners(event: ProcessEvent): Listener[] {
  return processEvents.listeners(event).filter((listener) => !listenersBefore[event].includes(listener));
}

const REQUEST_ERROR_ARGS = [
  new Error('boom'),
  { path: '/api/x', method: 'GET', headers: {} },
  { routerKind: 'App Router', routePath: '/api/x', routeType: 'route' },
] as unknown as Parameters<typeof import('@/instrumentation').onRequestError>;

describe('server instrumentation', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    mocks.init.mockReset(); mocks.configured.mockReturnValue(true);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs'); vi.stubEnv('VERCEL_ENV', 'production');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listenersBefore = {
      unhandledRejection: processEvents.listeners('unhandledRejection'),
      uncaughtException: processEvents.listeners('uncaughtException'),
    };
  });
  afterEach(() => {
    for (const event of EVENTS) for (const listener of addedListeners(event)) processEvents.off(event, listener);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')];
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('registers without loading the SDK, and logs only the hook timing', async () => {
    const { register } = await import('@/instrumentation'); await register();
    expect(mocks.imported).not.toHaveBeenCalled();
    expect(mocks.init).not.toHaveBeenCalled();
    const record = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(record).toEqual({ level: 'info', msg: 'server_registration_timing', ts: expect.any(String), elapsedMs: expect.any(Number) });
    expect(addedListeners('unhandledRejection')).toHaveLength(1);
    expect(addedListeners('uncaughtException')).toHaveLength(1);
  });

  it('loads and initialises the SDK once, with its privacy settings, on the first request error', async () => {
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await onRequestError(...REQUEST_ERROR_ARGS);
    await onRequestError(...REQUEST_ERROR_ARGS);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: 'private-dsn', sendDefaultPii: false, enableLogs: false, tracesSampleRate: 0, sampleRate: 1,
    }));
    expect(mocks.captureRequestError).toHaveBeenCalledTimes(2);
    expect(mocks.captureRequestError).toHaveBeenCalledWith(...REQUEST_ERROR_ARGS);
    // The SDK's own process handlers take over from the stand-ins.
    expect(addedListeners('unhandledRejection')).toHaveLength(0);
    expect(addedListeners('uncaughtException')).toHaveLength(0);
  });

  it('keeps the Vercel function alive while the first report loads', async () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil }) };
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError(...REQUEST_ERROR_ARGS);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(mocks.captureRequestError).toHaveBeenCalledTimes(1);
  });

  it('logs a failed init without throwing into Next, and tries again on the next error', async () => {
    mocks.init.mockImplementationOnce(() => { throw new Error('init failed'); });
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await expect(onRequestError(...REQUEST_ERROR_ARGS)).resolves.toBeUndefined();
    expect(mocks.captureRequestError).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not load the server SDK'), expect.any(Error));
    await onRequestError(...REQUEST_ERROR_ARGS);
    expect(mocks.init).toHaveBeenCalledTimes(2);
    expect(mocks.captureRequestError).toHaveBeenCalledTimes(1);
  });

  it('reports an unhandled rejection through the SDK without ending the process', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { register } = await import('@/instrumentation');
    await register();
    const [standIn] = addedListeners('unhandledRejection');
    const reason = new Error('nobody caught me');
    standIn(reason);
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledWith(reason, expect.objectContaining({
      mechanism: { type: 'auto.node.onunhandledrejection', handled: false },
    })));
    expect(mocks.flush).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('rejecting a promise which was not handled'));
  });

  it('reports an uncaught exception, then ends the process when no other handler decides', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    for (const listener of processEvents.listeners('uncaughtException')) processEvents.off('uncaughtException', listener);
    try {
      const { register } = await import('@/instrumentation');
      await register();
      const [standIn] = processEvents.listeners('uncaughtException');
      const error = new Error('thrown in a timer');
      standIn(error);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(mocks.captureException).toHaveBeenCalledWith(error, expect.objectContaining({
        mechanism: { type: 'auto.node.onuncaughtexception', handled: false },
      }));
    } finally {
      for (const listener of listenersBefore.uncaughtException) processEvents.on('uncaughtException', listener);
    }
  });

  it('leaves the decision to another uncaught-exception handler when there is one', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const other: Listener = () => {};
    processEvents.on('uncaughtException', other);
    try {
      const { register } = await import('@/instrumentation');
      await register();
      const standIn = addedListeners('uncaughtException').find((listener) => listener !== other)!;
      standIn(new Error('thrown in a timer'));
      await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(exit).not.toHaveBeenCalled();
    } finally {
      processEvents.off('uncaughtException', other);
    }
  });

  it('installs nothing and reports nothing without a DSN', async () => {
    mocks.configured.mockReturnValue(false);
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await onRequestError(...REQUEST_ERROR_ARGS);
    expect(addedListeners('unhandledRejection')).toHaveLength(0);
    expect(addedListeners('uncaughtException')).toHaveLength(0);
    expect(mocks.imported).not.toHaveBeenCalled();
    expect(mocks.captureRequestError).not.toHaveBeenCalled();
  });

  it('leaves the edge runtime untouched', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register, onRequestError } = await import('@/instrumentation');
    await register();
    await onRequestError(...REQUEST_ERROR_ARGS);
    expect(mocks.configured).not.toHaveBeenCalled(); expect(mocks.init).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(addedListeners('unhandledRejection')).toHaveLength(0);
  });
});
