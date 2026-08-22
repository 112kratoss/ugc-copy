// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => sentryMocks);
vi.mock('@/lib/sentry-config', () => ({
  SENTRY_ERROR_SAMPLE_RATE: 1,
  SENTRY_TRACES_SAMPLE_RATE: 0,
  assertSentryConfigured: () => true,
  resolveSentryDsn: () => 'https://public@example.invalid/1',
  resolveSentryEnvironment: () => 'test',
}));

describe('browser instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    sentryMocks.captureException.mockReset();
    sentryMocks.init.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the SDK off the startup path and flushes an early error on demand', async () => {
    const instrumentation = await import('@/instrumentation-client');

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(instrumentation.onRouterTransitionStart()).toBeUndefined();
    expect(sentryMocks.init).not.toHaveBeenCalled();

    const earlyError = new Error('startup failed');
    window.dispatchEvent(new ErrorEvent('error', { error: earlyError }));

    await vi.waitFor(() => expect(sentryMocks.init).toHaveBeenCalledOnce());
    expect(sentryMocks.captureException).toHaveBeenCalledWith(earlyError);
    expect(sentryMocks.init).toHaveBeenCalledWith(expect.objectContaining({
      sampleRate: 1,
      sendDefaultPii: false,
      tracesSampleRate: 0,
    }));
  });
});
