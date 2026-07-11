import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FEED_ANONYMOUS_COOKIE_NAME,
  FEED_INSTALLATION_ID_HEADER,
  getFeedNetworkKeyHash,
  isValidFeedInstallationId,
  resolveFeedAnonymousIdentity,
} from '@/lib/showcase-feed-identity';

describe('showcase feed anonymous identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps a server-issued web cookie stable without exposing the raw identifier', () => {
    vi.stubEnv('FEED_ANALYTICS_SALT', 'test-feed-salt');
    const first = resolveFeedAnonymousIdentity(new Request('https://magicbooklet.test/api/showcase/feed'));

    expect(first.source).toBe('web-cookie');
    expect(first.cookieValueToSet).toMatch(/^fid_[a-f0-9]{64}$/);
    expect(first.anonymousKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.anonymousKeyHash).not.toContain(first.cookieValueToSet as string);

    const second = resolveFeedAnonymousIdentity(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: { cookie: `${FEED_ANONYMOUS_COOKIE_NAME}=${first.cookieValueToSet}` },
    }));
    expect(second).toEqual({
      anonymousKeyHash: first.anonymousKeyHash,
      cookieValueToSet: null,
      source: 'web-cookie',
    });
  });

  it('uses a validated installation header across network changes', () => {
    vi.stubEnv('FEED_ANALYTICS_SALT', 'test-feed-salt');
    const installationId = `fid_${'a'.repeat(64)}`;
    const first = resolveFeedAnonymousIdentity(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: {
        [FEED_INSTALLATION_ID_HEADER]: installationId,
        'x-forwarded-for': '203.0.113.1',
      },
    }));
    const second = resolveFeedAnonymousIdentity(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: {
        [FEED_INSTALLATION_ID_HEADER]: installationId,
        'x-forwarded-for': '203.0.113.99',
      },
    }));

    expect(first.source).toBe('mobile-installation');
    expect(first.anonymousKeyHash).toBe(second.anonymousKeyHash);
    expect(first.cookieValueToSet).toBeNull();
  });

  it('never trusts malformed client IDs and retains a salted network fallback', () => {
    vi.stubEnv('FEED_ANALYTICS_SALT', 'test-feed-salt');
    const request = new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: {
        [FEED_INSTALLATION_ID_HEADER]: 'attacker-selected-id',
        'x-forwarded-for': '203.0.113.8',
        'user-agent': 'test-client',
      },
    });
    const identity = resolveFeedAnonymousIdentity(request);

    expect(isValidFeedInstallationId('attacker-selected-id')).toBe(false);
    expect(identity).toEqual({
      anonymousKeyHash: getFeedNetworkKeyHash(request),
      cookieValueToSet: null,
      source: 'network-fallback',
    });
  });

  it('does not let user-agent rotation bypass the anonymous network key', () => {
    vi.stubEnv('FEED_ANALYTICS_SALT', 'test-feed-salt');
    const first = getFeedNetworkKeyHash(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: { 'x-forwarded-for': '203.0.113.8', 'user-agent': 'client-a' },
    }));
    const rotatedAgent = getFeedNetworkKeyHash(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: { 'x-forwarded-for': '203.0.113.8', 'user-agent': 'client-b' },
    }));
    const differentNetwork = getFeedNetworkKeyHash(new Request('https://magicbooklet.test/api/showcase/feed', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'client-a' },
    }));

    expect(rotatedAgent).toBe(first);
    expect(differentNetwork).not.toBe(first);
  });
});
