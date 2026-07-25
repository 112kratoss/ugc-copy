import { describe, expect, it } from 'vitest';

import { getClientNetworkKey } from '@/lib/client-network-key';

describe('client network key derivation', () => {
  it('prefers the platform-set x-vercel-forwarded-for over a spoofed x-forwarded-for', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.10',
      'x-forwarded-for': '198.51.100.99, 203.0.113.10',
      'x-real-ip': '198.51.100.98',
    });

    expect(getClientNetworkKey(headers)).toBe('203.0.113.10');
  });

  it('uses only the first entry of a multi-hop x-vercel-forwarded-for chain', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': ' 203.0.113.20 , 10.0.0.1',
    });

    expect(getClientNetworkKey(headers)).toBe('203.0.113.20');
  });

  it('falls back to x-forwarded-for when the platform header is absent', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.30, 10.0.0.5',
      'x-real-ip': '198.51.100.2',
    });

    expect(getClientNetworkKey(headers)).toBe('203.0.113.30');
  });

  it('falls back to x-real-ip and then the loopback default', () => {
    expect(getClientNetworkKey(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(getClientNetworkKey(new Headers())).toBe('127.0.0.1');
  });

  it('caps oversized header values so they cannot bloat rate-limit keys', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': 'a'.repeat(500),
    });

    expect(getClientNetworkKey(headers)).toHaveLength(128);
  });
});
