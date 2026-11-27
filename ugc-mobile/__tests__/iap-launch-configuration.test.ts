import { beforeEach, describe, expect, it, vi } from 'vitest';

// Audit 2026-11-27, finding 3: RevenueCat was set up only when the Credits tab mounted, so a
// purchase the store approved later (a Play pending payment, Ask to Buy) or one interrupted was
// posted only when that tab opened again. The app now sets it up once after launch, and again
// when the identity changes.

const purchases = vi.hoisted(() => {
  const state = { configured: false, appUserId: null as string | null };
  return {
    state,
    isConfigured: vi.fn(async () => state.configured),
    configure: vi.fn(({ appUserID }: { appUserID: string }) => {
      state.configured = true;
      state.appUserId = appUserID;
    }),
    getAppUserID: vi.fn(async () => state.appUserId),
    logIn: vi.fn(async (id: string) => { state.appUserId = id; }),
    setLogHandler: vi.fn(),
  };
});

vi.mock('react-native-purchases', () => ({
  default: purchases,
  LOG_LEVEL: { ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO' },
}));
vi.mock('../lib/env', () => ({ env: { revenueCatIosApiKey: 'ios-key', revenueCatAndroidApiKey: 'android-key' } }));

import { configureIapForUser } from '../lib/iap';
import { createIapLaunchConfigurator } from '../lib/iap-launch-configuration';

beforeEach(() => {
  vi.clearAllMocks();
  purchases.state.configured = false;
  purchases.state.appUserId = null;
});

describe('configureIapForUser', () => {
  it('configures RevenueCat once when the launch and the Credits tab ask at the same moment', async () => {
    await Promise.all([configureIapForUser('user-1', 'android'), configureIapForUser('user-1', 'android')]);
    expect(purchases.configure).toHaveBeenCalledTimes(1);
    expect(purchases.logIn).not.toHaveBeenCalled();
  });

  it('logs the new identity in once RevenueCat is configured', async () => {
    await configureIapForUser('user-1', 'android');
    await configureIapForUser('user-2', 'android');
    expect(purchases.logIn).toHaveBeenCalledWith('user-2');
  });

  it('lets a later call run after one that failed', async () => {
    purchases.isConfigured.mockRejectedValueOnce(new Error('native module unavailable'));
    await expect(configureIapForUser('user-1', 'android')).rejects.toThrow('native module unavailable');
    await expect(configureIapForUser('user-1', 'android')).resolves.toBe(true);
  });
});

describe('the launch configurator', () => {
  it('sets up each identity once, and again for a new one', async () => {
    const configure = vi.fn(async () => true);
    const configurator = createIapLaunchConfigurator({ configure, os: 'ios' });

    await configurator.sync('guest-1');
    await configurator.sync('guest-1');
    await configurator.sync('account-1');

    expect(configure.mock.calls).toEqual([['guest-1', 'ios'], ['account-1', 'ios']]);
  });

  it('does nothing without an identity or off the phone platforms', async () => {
    const configure = vi.fn(async () => true);
    await createIapLaunchConfigurator({ configure, os: 'ios' }).sync(null);
    await createIapLaunchConfigurator({ configure, os: 'web' }).sync('guest-1');
    expect(configure).not.toHaveBeenCalled();
  });

  it('never throws, and tries a failed identity again at its next sync', async () => {
    const configure = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    const configurator = createIapLaunchConfigurator({ configure, os: 'android' });

    await expect(configurator.sync('guest-1')).resolves.toBeUndefined();
    await configurator.sync('guest-1');
    expect(configure).toHaveBeenCalledTimes(2);
  });
});
