import { describe, expect, it, vi } from 'vitest';

import {
  SENTRY_ERROR_SAMPLE_RATE,
  SENTRY_TRACES_SAMPLE_RATE,
  assertSentryConfigured,
  isSentryEnabled,
  resolveSentryDsn,
  resolveSentryEnvironment,
} from '@/lib/sentry-config';

describe('sentry configuration', () => {
  it('disables itself when no DSN is set, rather than failing', () => {
    // Local checkouts and CI must not need a Sentry account. A build that
    // required one would make every contributor depend on an external service.
    expect(isSentryEnabled({})).toBe(false);
    expect(resolveSentryDsn({})).toBeUndefined();
  });

  it('treats a blank DSN as absent', () => {
    // An env var set to an empty string is the usual shape of "someone added
    // the key to Vercel and never pasted the value". Sentry would accept '' and
    // initialise into a black hole.
    expect(isSentryEnabled({ NEXT_PUBLIC_SENTRY_DSN: '   ' })).toBe(false);
    expect(resolveSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: '' })).toBeUndefined();
  });

  it('warns when production is running without a DSN', () => {
    // The whole point. Silent absence in production is the failure mode that
    // only surfaces during the incident it was supposed to catch — the same
    // silent-optimism shape F15a removed from the cost report.
    const log = vi.fn();
    const configured = assertSentryConfigured({ VERCEL_ENV: 'production' }, log);

    expect(configured).toBe(false);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('error tracking is OFF');
  });

  it('stays quiet when a non-production environment has no DSN', () => {
    const log = vi.fn();

    expect(assertSentryConfigured({ VERCEL_ENV: 'preview' }, log)).toBe(false);
    expect(assertSentryConfigured({ NODE_ENV: 'development' }, log)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('does not warn when production is configured', () => {
    const log = vi.fn();
    const configured = assertSentryConfigured(
      { VERCEL_ENV: 'production', NEXT_PUBLIC_SENTRY_DSN: 'https://k@o1.ingest.us.sentry.io/2' },
      log,
    );

    expect(configured).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('prefers the browser-visible environment variable, then the server one', () => {
    // NEXT_PUBLIC_VERCEL_ENV is the only one of the two that exists in the
    // browser bundle, so preferring it keeps client and server events tagged
    // with the same environment instead of splitting into two.
    expect(resolveSentryEnvironment({
      NEXT_PUBLIC_VERCEL_ENV: 'production',
      VERCEL_ENV: 'preview',
      NODE_ENV: 'development',
    })).toBe('production');
    expect(resolveSentryEnvironment({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('preview');
    expect(resolveSentryEnvironment({ NODE_ENV: 'test' })).toBe('test');
    expect(resolveSentryEnvironment({})).toBe('unknown');
  });

  it('samples every error and no traces', () => {
    // Tracing is off deliberately: this item is scoped to error tracking, and
    // performance tracing on a free tier would burn the quota on feed request
    // volume before producing a usable signal.
    expect(SENTRY_ERROR_SAMPLE_RATE).toBe(1);
    expect(SENTRY_TRACES_SAMPLE_RATE).toBe(0);
  });
});
