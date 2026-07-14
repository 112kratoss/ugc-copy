import { describe, expect, it } from 'vitest';

import { resolveE2EAuthBypass } from '@/lib/e2e-auth';

describe('E2E authentication bypass safety', () => {
  it('uses only the private flag on the server', () => {
    expect(resolveE2EAuthBypass({
      environment: {
        E2E_AUTH_BYPASS: '1',
        NEXT_PUBLIC_E2E_AUTH_BYPASS: undefined,
        NODE_ENV: 'test',
        VERCEL_ENV: undefined,
      },
      isBrowser: false,
    })).toBe(true);

    expect(resolveE2EAuthBypass({
      environment: {
        E2E_AUTH_BYPASS: undefined,
        NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
        NODE_ENV: 'test',
        VERCEL_ENV: undefined,
      },
      isBrowser: false,
    })).toBe(false);
  });

  it('uses only the public flag in the browser', () => {
    expect(resolveE2EAuthBypass({
      environment: {
        E2E_AUTH_BYPASS: undefined,
        NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
        NODE_ENV: 'test',
        VERCEL_ENV: undefined,
      },
      isBrowser: true,
    })).toBe(true);
  });

  it.each([
    { NODE_ENV: 'production', VERCEL_ENV: undefined },
    { NODE_ENV: 'test', VERCEL_ENV: 'production' },
  ] as const)('rejects either bypass flag in production (%o)', (runtime) => {
    expect(() => resolveE2EAuthBypass({
      environment: {
        E2E_AUTH_BYPASS: '1',
        NEXT_PUBLIC_E2E_AUTH_BYPASS: undefined,
        ...runtime,
      },
      isBrowser: false,
    })).toThrow('must never be enabled');

    expect(() => resolveE2EAuthBypass({
      environment: {
        E2E_AUTH_BYPASS: undefined,
        NEXT_PUBLIC_E2E_AUTH_BYPASS: '1',
        ...runtime,
      },
      isBrowser: true,
    })).toThrow('must never be enabled');
  });
});
