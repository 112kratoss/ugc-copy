import fs from 'node:fs';
import path from 'node:path';

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

  it('reads every NEXT_PUBLIC_ value as a literal process.env member expression', () => {
    // REGRESSION GUARD, and it caught a real production miss.
    //
    // Next inlines NEXT_PUBLIC_* into the client bundle by substituting the
    // literal text `process.env.NEXT_PUBLIC_FOO`. Reading it through a variable
    // — `environment.NEXT_PUBLIC_SENTRY_DSN`, where `environment` merely
    // defaults to `process.env` — never matches, and `process.env` is an empty
    // shim in the browser. The first deploy shipped exactly that: the
    // instrumentation module was in the bundle, the DSN was not, Sentry never
    // initialised, and because resolveSentryEnvironment had the same flaw it
    // read 'unknown' instead of 'production' so the warning stayed silent too.
    //
    // No unit test can observe bundler substitution, so this asserts the source
    // shape that makes it possible. `getSentryConfigSource` deliberately reads
    // the file rather than importing it.
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/sentry-config.ts'),
      'utf8',
    );

    expect(source).toContain('NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN');
    expect(source).toContain('NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV');
    // No exported function may default its environment argument to the bare
    // `process.env`, which is what reintroduces the bug.
    expect(source).not.toMatch(/undefined>\s*=\s*process\.env\s*,/);
  });

  it('samples every error and no traces', () => {
    // Tracing is off deliberately: this item is scoped to error tracking, and
    // performance tracing on a free tier would burn the quota on feed request
    // volume before producing a usable signal.
    expect(SENTRY_ERROR_SAMPLE_RATE).toBe(1);
    expect(SENTRY_TRACES_SAMPLE_RATE).toBe(0);
  });
});
