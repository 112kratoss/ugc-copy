import { afterEach, describe, expect, it, vi } from 'vitest';

// The point of src/instrumentation.ts: registering an instance loads no Sentry SDK
// (the import cost a fresh instance's first request 0.6–1.1 s). In a file of its
// own, because a mocked module's factory runs once a file whatever
// vi.resetModules() does, so only a first import can be counted.
const mocks = vi.hoisted(() => ({ imported: vi.fn() }));
vi.mock('@sentry/nextjs', () => {
  mocks.imported();
  return { init: vi.fn(), captureRequestError: vi.fn(), captureException: vi.fn(), flush: vi.fn(async () => true) };
});
vi.mock('@/lib/sentry-config', () => ({
  SENTRY_ERROR_SAMPLE_RATE: 1, SENTRY_TRACES_SAMPLE_RATE: 0,
  assertSentryConfigured: () => true,
  resolveSentryDsn: () => 'private-dsn', resolveSentryEnvironment: () => 'production',
}));

describe('registering the server runtime', () => {
  afterEach(() => {
    const events = process as unknown as {
      listeners(event: string): Array<(...args: unknown[]) => void>;
      off(event: string, listener: (...args: unknown[]) => void): void;
    };
    for (const event of ['unhandledRejection', 'uncaughtException']) {
      for (const listener of events.listeners(event)) {
        if ((listener as { __magicbookletSentryStandIn?: true }).__magicbookletSentryStandIn) events.off(event, listener);
      }
    }
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('magicbooklet.sentry.serverStandIns')];
    vi.unstubAllEnvs();
  });

  it('imports no part of the SDK', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register } = await import('@/instrumentation');
    await register();
    expect(mocks.imported).not.toHaveBeenCalled();
  });
});
