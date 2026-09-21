import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ init: vi.fn(), configured: vi.fn(() => true) }));
vi.mock('@sentry/nextjs', () => ({ init: mocks.init }));
vi.mock('@/lib/sentry-config', () => ({
  SENTRY_ERROR_SAMPLE_RATE: 1, SENTRY_TRACES_SAMPLE_RATE: 0,
  assertSentryConfigured: mocks.configured,
  resolveSentryDsn: () => 'private-dsn', resolveSentryEnvironment: () => 'production',
}));

describe('server registration timing', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    mocks.init.mockReset(); mocks.configured.mockReturnValue(true);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs'); vi.stubEnv('VERCEL_ENV', 'production');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('logs only hook timing without changing Sentry privacy settings', async () => {
    const { register } = await import('@/instrumentation'); await register();
    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false, enableLogs: false }));
    const record = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(record).toEqual({ level: 'info', msg: 'server_registration_timing', ts: expect.any(String), elapsedMs: expect.any(Number) });
  });
  it('keeps initialization failures observable and does not swallow them', async () => {
    mocks.init.mockImplementation(() => { throw new Error('init failed'); });
    const { register } = await import('@/instrumentation');
    await expect(register()).rejects.toThrow('init failed');
    expect(console.log).toHaveBeenCalledTimes(1);
  });
  it('leaves the edge runtime untouched', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('@/instrumentation'); await register();
    expect(mocks.configured).not.toHaveBeenCalled(); expect(mocks.init).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });
});
